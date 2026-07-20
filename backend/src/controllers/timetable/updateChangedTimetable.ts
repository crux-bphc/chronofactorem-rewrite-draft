import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  courseWithSectionsType,
  namedNonEmptyStringType,
  type sectionTypeList,
} from "../../../../lib/src/index.js";
import { env } from "../../config/server.js";
import { AppDataSource } from "../../db.js";
import { Course, Section, Timetable } from "../../entity/entities.js";
import { validate } from "../../middleware/zodValidateRequest.js";
import { timetableRepository } from "../../repositories/timetableRepository.js";
import { checkForExamTimingsChange } from "../../utils/checkForChange.js";
import {
  checkForClassHoursClash,
  checkForExamHoursClash,
} from "../../utils/checkForClashes.js";
import {
  addCourse,
  addTimetable,
  removeCourse,
  removeTimetable,
} from "../../utils/search.js";
import { addExamTimings, removeSection } from "../../utils/updateSection.js";
import { updateSectionWarnings } from "../../utils/updateWarnings.js";

const dataSchema = z.object({
  body: z.object({
    chronoSecret: namedNonEmptyStringType("chronoSecret"),
    course: courseWithSectionsType,
  }),
});

export const updateChangedTimetableValidator = validate(dataSchema);

export const updateChangedTimetable = async (req: Request, res: Response) => {
  const logger = req.log;
  const queryRunner = AppDataSource.createQueryRunner();
  let timetables: Timetable[] = [];
  try {
    if (env.CHRONO_SECRET !== req.body.chronoSecret) {
      return res.status(401).json({ message: "Chrono Secret is incorrect" });
    }
    const course: Course = req.body.course;
    // Use a transaction because we will run many dependent mutations
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // fetch original course to check existence and original code
    const originalCourse = await queryRunner.manager.findOne(Course, {
      where: { id: course.id, archived: false },
    });
    if (!originalCourse) {
      await queryRunner.rollbackTransaction();
      return res.status(404).json({ message: "Course not found" });
    }

    // Update the course's exam timings, also make sure that the course is not archived
    try {
      await queryRunner.manager
        .createQueryBuilder()
        .update(Course)
        .set({
          name: course?.name,
          code: course?.code,
          midsemStartTime: course?.midsemStartTime,
          midsemEndTime: course?.midsemEndTime,
          compreStartTime: course?.compreStartTime,
          compreEndTime: course?.compreEndTime,
        })
        .where("id = :id", { id: course?.id })
        .andWhere("archived = :archived", { archived: false })
        .execute();
    } catch (err: any) {
      logger.error("Error while querying for course: ", err.message);
      await queryRunner.rollbackTransaction();
      return res.status(500).json({ message: "Internal Server Error" });
    }

    // Fetch the total types of sections of that course (required later to update warnings)
    let requiredSectionTypes: sectionTypeList = [];
    try {
      const sectionTypeHolders = await queryRunner.manager
        .createQueryBuilder(Section, "section")
        .select("section.type")
        .where("section.courseId = :courseId", { courseId: course.id })
        .distinctOn(["section.type"])
        .getMany();
      requiredSectionTypes = sectionTypeHolders.map((section) => section.type);
    } catch (err: any) {
      logger.error(
        "Error while querying for course's section types: ",
        err.message,
      );
      await queryRunner.rollbackTransaction();
      return res.status(500).json({ message: "Internal Server Error" });
    }

    // fetch all sections from db to find deleted ones
    const dbSections = await queryRunner.manager
      .createQueryBuilder(Section, "section")
      .where("section.courseId = :courseId", { courseId: course.id })
      .getMany();
    const dbSectionIds = new Set(dbSections.map((s) => s.id));
    const incomingSectionIds = new Set(
      course.sections.map((s: any) => s.id).filter(Boolean),
    );

    // new sections have no id or id not in db
    const newSections = course.sections.filter(
      (s: any) => !s.id || !dbSectionIds.has(s.id),
    );
    // deleted sections are in db but not in incoming
    const deletedSections = dbSections.filter(
      (s) => !incomingSectionIds.has(s.id),
    );
    const deletedSectionIds = new Set(deletedSections.map((s) => s.id));

    // Fetch the timetables that are affected, archived timetables cannot be affected
    try {
      timetables = await queryRunner.manager
        .createQueryBuilder(Timetable, "timetable")
        .leftJoinAndSelect("timetable.sections", "section")
        .where("section.courseId = :id", { id: course?.id })
        .andWhere("timetable.archived = :archived", { archived: false })
        .getMany();
    } catch (err: any) {
      logger.error("Error while querying for timetable: ", err.message);
      await queryRunner.rollbackTransaction();
      return res.status(500).json({ message: "Internal Server Error" });
    }

    for (const timetable of timetables) {
      // rename course code in timings, warnings, and examtimes if code changed
      if (course.code !== originalCourse.code) {
        timetable.timings = timetable.timings.map((t) => {
          if (t.startsWith(`${originalCourse.code}:`)) {
            return t.replace(`${originalCourse.code}:`, `${course.code}:`);
          }
          return t;
        });
        timetable.warnings = timetable.warnings.map((w) => {
          if (w.startsWith(`${originalCourse.code}:`)) {
            return w.replace(`${originalCourse.code}:`, `${course.code}:`);
          }
          return w;
        });
        timetable.examTimes = timetable.examTimes.map((e) => {
          if (e.startsWith(`${originalCourse.code}|`)) {
            return e.replace(`${originalCourse.code}|`, `${course.code}|`);
          }
          return e;
        });
      }

      // For each timetable, check if the exam times have changed
      if (checkForExamTimingsChange(timetable, course)) {
        // If they have, remove the course's exams from the timings
        timetable.examTimes = timetable.examTimes.filter((examTime) => {
          const code = examTime.split("|")[0];
          return code !== originalCourse.code && code !== course?.code;
        });

        // Convert exam dates to actual dates from strings, since the
        // checkForExamHoursClash() function compares them with dates

        // This is needed because the course exam dates are not from DB,
        // but are from the JSON body of the request.
        // A similar procedure is used during ingestion as well.
        course.compreStartTime = new Date(course.compreStartTime);
        course.compreEndTime = new Date(course.compreEndTime);
        course.midsemStartTime = new Date(course.midsemStartTime);
        course.midsemEndTime = new Date(course.midsemEndTime);

        // Check if the new timings clash with any other timings of other courses
        if (checkForExamHoursClash(timetable, course).clash) {
          // If they do, then remove all sections of the course with updated timings
          for (const sec of timetable.sections) {
            await queryRunner.manager
              .createQueryBuilder()
              .relation(Timetable, "sections")
              .of(timetable)
              .remove(sec);
            removeSection(timetable, sec);
          }
          // Since the timetable has been changed, make it a draft
          timetable.draft = true;
          timetable.private = true;
        } else {
          // If there is no clash, simply add the new timings to the timetable
          const newExamTimes = timetable.examTimes;
          addExamTimings(newExamTimes, course);
          timetable.examTimes = newExamTimes;
        }
      }
      for (const section of timetable.sections) {
        // For each section of the course previously in the timetable, find its corresponding replacement
        const newSection = course.sections.find((el) => el.id === section.id);

        if (newSection !== undefined) {
          // Start off by removing the existing section, both in DB and the timings column of the timetable
          removeSection(timetable, section);
          await queryRunner.manager
            .createQueryBuilder()
            .relation(Timetable, "sections")
            .of(timetable)
            .remove(section);

          if (checkForClassHoursClash(timetable, newSection).clash) {
            // If the updated section will cause a clash, then keep the section removed
            // Also make the timetable a draft, and update its warnings since that
            // section is now gone
            timetable.draft = true;
            timetable.private = true;
            timetable.warnings = updateSectionWarnings(
              course.code,
              section,
              requiredSectionTypes,
              false,
              timetable.warnings,
            );
          } else {
            // If there is no clash, add the new section timings to the timetable
            const newTimes: string[] = newSection.roomTime.map(
              (time) =>
                `${course?.code}:${time.split(":")[2]}${time.split(":")[3]}`,
            );
            // Add the section back to the timetable
            await queryRunner.manager
              .createQueryBuilder()
              .relation(Timetable, "sections")
              .of(timetable)
              .add(section);

            // Update the timings and the sections in the timetable object
            timetable.timings = [...timetable.timings, ...newTimes];
            timetable.sections = [...timetable.sections, newSection];
          }
        } else if (deletedSectionIds.has(section.id)) {
          // section was deleted entirely in this edit, drop it from the timetable
          removeSection(timetable, section);
          await queryRunner.manager
            .createQueryBuilder()
            .relation(Timetable, "sections")
            .of(timetable)
            .remove(section);
          timetable.draft = true;
          timetable.private = true;
          timetable.warnings = updateSectionWarnings(
            course.code,
            section,
            requiredSectionTypes,
            false,
            timetable.warnings,
          );
        }
      }

      // After all that, if the timetable now has 0 sections of that course,
      // remove its exam timings as well, removing it fully from the timetable
      const sameCourseSections: Section[] = timetable.sections.filter(
        (currentSection) => {
          return (
            currentSection.courseId === course.id &&
            !deletedSectionIds.has(currentSection.id)
          );
        },
      );
      if (sameCourseSections.length === 0) {
        timetable.examTimes = timetable.examTimes.filter((examTime) => {
          return examTime.split("|")[0] !== course?.code;
        });
      }
    }

    // Remove sections from the timetable before saving in db

    // Since we are fetching only this course's sections in the
    // timetable query (due to the left join), none of the other sections
    // end up in timetable.sections. Saving this to db causes all the other
    // sections of other courses to be wiped. This is why, using some typescript
    // magic, we redefine the timetable type, and then set sections = undefined.
    // Since sections = undefined, TypeORM sees that the field isn't present,
    // and doesn't make any additional changes to timetable sections.

    // If we do want to remove the sections, those db calls have already been
    // made above. This db call is only here to update timetable timings and examTimes
    type timetableWithoutSections = Omit<Timetable, "sections"> & {
      sections: Section[] | undefined;
    };
    const timetablesWithoutSections: timetableWithoutSections[] = timetables;
    await queryRunner.manager.save(
      timetablesWithoutSections.map((x) => {
        x.sections = undefined;
        return x;
      }),
    );

    // delete sections from db that were removed from the course entirely
    if (deletedSections.length > 0) {
      await queryRunner.manager
        .createQueryBuilder()
        .delete()
        .from(Section)
        .where("id IN (:...ids)", { ids: deletedSections.map((s) => s.id) })
        .execute();
    }

    // Regardless of whether or not a section was present in a timetable,
    // update the section's fields (schedule, instructors, type, section number)
    try {
      for (const section of course.sections.filter(
        (s: any) => s.id && dbSectionIds.has(s.id),
      )) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Section)
          .set({
            roomTime: section.roomTime,
            instructors: section.instructors,
            type: section.type,
            number: section.number,
          })
          .where("section.id = :id", { id: section?.id })
          .execute();
      }
    } catch (err: any) {
      logger.error("Error while updating sections: ", err.message);
      await queryRunner.rollbackTransaction();
      return res.status(500).json({ message: "Internal Server Error" });
    }

    // insert brand new sections added in this edit
    const newSectionValues = newSections.map((s: any) => ({
      id: s.id || randomUUID(),
      courseId: course.id,
      type: s.type,
      number: s.number,
      instructors: s.instructors,
      roomTime: s.roomTime,
      createdAt: s.createdAt ? new Date(s.createdAt) : new Date(),
    }));
    if (newSectionValues.length > 0) {
      await queryRunner.manager
        .createQueryBuilder()
        .insert()
        .into(Section)
        .values(newSectionValues)
        .execute();
    }

    // After everything passes fine, commit the transaction
    await queryRunner.commitTransaction();
  } catch (err: any) {
    logger.error("Transaction failed: ", err.message);
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    return res.status(500).json({ message: "Internal Server Error" });
  } finally {
    await queryRunner.release();
  }

  // update course in search service
  try {
    const courseObj = req.body.course;
    await removeCourse(courseObj.id, logger);
    const updatedCourseForSearch = await AppDataSource.manager
      .createQueryBuilder(Course, "course")
      .leftJoinAndSelect("course.sections", "section")
      .where("course.id = :id", { id: courseObj.id })
      .getOne();
    if (updatedCourseForSearch) {
      await addCourse(updatedCourseForSearch, logger);
    }
  } catch (_err: any) {
    return res.status(500).json({ message: "Internal Server Error" });
  }

  // update timetables in search service
  for (const timetable of timetables) {
    try {
      await removeTimetable(timetable.id, logger);
    } catch (_err: any) {
      return res.status(500).json({ message: "Internal Server Error" });
    }
    if (!timetable.draft && !timetable.private) {
      try {
        const timetableWithSections = await timetableRepository
          .createQueryBuilder("timetable")
          .leftJoinAndSelect("timetable.sections", "section")
          .where("timetable.id = :id", { id: timetable.id })
          .getOneOrFail();
        await addTimetable(timetableWithSections, null, logger);
      } catch (_err: any) {
        return res.status(500).json({ message: "Internal Server Error" });
      }
    }
  }

  return res.json({ message: "Timetable successfully updated" });
};