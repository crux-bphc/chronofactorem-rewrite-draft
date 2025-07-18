import type { Request, Response } from "express";
import { z } from "zod";
import {
  namedUUIDType,
  type sectionTypeList,
  timetableIDType,
} from "../../../../lib/src/index.js";
import {
  type Course,
  type Section,
  Timetable,
  type User,
} from "../../entity/entities.js";
import { validate } from "../../middleware/zodValidateRequest.js";
import { courseRepository } from "../../repositories/courseRepository.js";
import { sectionRepository } from "../../repositories/sectionRepository.js";
import { timetableRepository } from "../../repositories/timetableRepository.js";
import { userRepository } from "../../repositories/userRepository.js";
import {
  checkForClassHoursClash,
  checkForExamHoursClash,
} from "../../utils/checkForClashes.js";
import sqids, { validSqid } from "../../utils/sqids.js";
import { updateSectionWarnings } from "../../utils/updateWarnings.js";

const dataSchema = z.object({
  body: z.object({
    sectionId: namedUUIDType("section"),
  }),
  params: z.object({
    id: timetableIDType,
  }),
});

export const addSectionValidator = validate(dataSchema);

export const addSection = async (req: Request, res: Response) => {
  const logger = req.log;
  const dbID = sqids.decode(req.params.id);
  if (!validSqid(dbID)) {
    return res.status(404).json({ message: "Timetable does not exist" });
  }

  const sectionId = req.body.sectionId;

  let author: User | null = null;

  try {
    author = await userRepository
      .createQueryBuilder("user")
      .where("user.id = :id", { id: req.session?.id })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying user: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!author) {
    return res.status(401).json({ message: "unregistered user" });
  }

  let timetable: Timetable | null = null;

  try {
    timetable = await timetableRepository
      .createQueryBuilder("timetable")
      .where("timetable.id = :id", { id: dbID[0] })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying timetable: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!timetable) {
    return res.status(404).json({ message: "timetable not found" });
  }

  if (timetable.authorId !== author.id) {
    return res.status(403).json({ message: "user does not own timetable" });
  }

  if (!timetable.draft) {
    return res.status(418).json({ message: "timetable is not a draft" });
  }

  if (timetable.archived) {
    return res.status(418).json({ message: "timetable is archived" });
  }

  let section: Section | null = null;

  try {
    section = await sectionRepository
      .createQueryBuilder("section")
      .where("section.id = :id", { id: sectionId })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying for section: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!section) {
    return res.status(404).json({ message: "section not found" });
  }

  let course: Course | null = null;
  const courseId = section.courseId;

  try {
    course = await courseRepository
      .createQueryBuilder("course")
      .where("course.id = :id", { id: courseId })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying for course: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!course) {
    return res.status(404).json({ message: "course not found" });
  }

  if (course.archived) {
    return res.status(418).json({ message: "course is archived" });
  }

  const classHourClashes = checkForClassHoursClash(timetable, section);
  if (classHourClashes.clash) {
    return res.status(400).json({
      message: `section clashes with ${classHourClashes.course}`,
    });
  }

  const examHourClashes = checkForExamHoursClash(timetable, course);
  if (examHourClashes.clash && !examHourClashes.sameCourse) {
    return res.status(400).json({
      message: `course's exam clashes with ${examHourClashes.course}'s ${examHourClashes.exam}`,
    });
  }

  let sectionTypes: sectionTypeList = [];

  try {
    const sectionTypeHolders = await sectionRepository
      .createQueryBuilder("section")
      .select("section.type")
      .where("section.courseId = :courseId", { courseId: courseId })
      .distinctOn(["section.type"])
      .getMany();
    sectionTypes = sectionTypeHolders.map((section) => section.type);
  } catch (err: any) {
    logger.error(
      "Error while querying for course's section types: ",
      err.message,
    );

    res.status(500).json({ message: "Internal Server Error" });
  }

  let sameCourseSectionsCount = 0;

  try {
    sameCourseSectionsCount = await sectionRepository
      .createQueryBuilder("section")
      .innerJoin("section.timetables", "timetable")
      .where("timetable.id = :id", { id: timetable.id })
      .andWhere("section.courseId = :courseId", { courseId })
      .andWhere("section.type = :type", { type: section.type })
      .getCount();
  } catch (err: any) {
    logger.error(
      "Error while querying for other sections of same course: ",
      err.message,
    );

    res.status(500).json({ message: "Internal Server Error" });
  }

  if (sameCourseSectionsCount > 0) {
    return res.status(400).json({
      message: `can't have multiple sections of type ${section.type}`,
    });
  }

  timetable.warnings = updateSectionWarnings(
    course.code,
    section,
    sectionTypes,
    true,
    timetable.warnings,
  );

  const newTimes: string[] = section.roomTime.map(
    (time) => `${course?.code}:${time.split(":")[2]}${time.split(":")[3]}`,
  );

  const newExamTimes = timetable.examTimes;
  if (course.midsemStartTime !== null && course.midsemEndTime !== null) {
    newExamTimes.push(
      `${
        course.code
      }|MIDSEM|${course.midsemStartTime.toISOString()}|${course.midsemEndTime.toISOString()}`,
    );
  }
  if (course.compreStartTime !== null && course.compreEndTime !== null) {
    newExamTimes.push(
      `${
        course.code
      }|COMPRE|${course.compreStartTime.toISOString()}|${course.compreEndTime.toISOString()}`,
    );
  }

  try {
    await timetableRepository.manager.transaction(
      async (transactionalEntityManager) => {
        // shoudn't be needed, but kept them here as it was erroring out
        if (!course) {
          return res.status(404).json({ message: "course not found" });
        }
        if (!timetable) {
          return res.status(404).json({ message: "timetable not found" });
        }

        await transactionalEntityManager
          .createQueryBuilder()
          .relation(Timetable, "sections")
          .of(timetable)
          .add(section);

        await transactionalEntityManager
          .createQueryBuilder()
          .update(Timetable)
          .set({
            timings: [...timetable.timings, ...newTimes],
            warnings: timetable.warnings,
          })
          .where("timetable.id = :id", { id: timetable.id })
          .execute();

        if (!examHourClashes.sameCourse) {
          await transactionalEntityManager
            .createQueryBuilder()
            .update(Timetable)
            .set({
              examTimes: newExamTimes,
            })
            .where("timetable.id = :id", { id: timetable.id })
            .execute();
        }
      },
    );
  } catch (err: any) {
    logger.error("Error while updating timetable with section: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }
  return res.json({ message: "section added" });
};
