import type { Request, Response } from "express";
import { z } from "zod";
import { type degreeEnum, timetableIDType } from "../../../../lib/src/index.js";
import { type Section, Timetable, type User } from "../../entity/entities.js";
import { validate } from "../../middleware/zodValidateRequest.js";
import { timetableRepository } from "../../repositories/timetableRepository.js";
import { userRepository } from "../../repositories/userRepository.js";
import timetableJSON from "../../timetable.json" with { type: "json" };
import sqids, { validSqid } from "../../utils/sqids.js";

const dataSchema = z.object({
  params: z.object({
    id: timetableIDType,
  }),
});

export const copyTimetableValidator = validate(dataSchema);

export const copyTimetable = async (req: Request, res: Response) => {
  const logger = req.log;
  let author: User | null = null;
  const dbID = sqids.decode(req.params.id);
  if (!validSqid(dbID)) {
    return res.status(404).json({ message: "Timetable does not exist" });
  }

  try {
    author = await userRepository
      .createQueryBuilder("user")
      .where("user.id = :id", { id: req.session?.id })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying for user: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!author) {
    return res.status(401).json({ message: "unregistered user" });
  }

  // new timetable default properties
  const name = "Untitled Timetable";
  const degrees: degreeEnum[] = author.degrees;
  const isPrivate = true;
  const isDraft = true;
  const isArchived = false;
  const acadYear = timetableJSON.metadata.acadYear;
  const year: number = acadYear - author.batch + 1;
  const semester = timetableJSON.metadata.semester;
  const sections: Section[] = [];
  let timings: string[] = [];
  let examTimes: string[] = [];
  let warnings: string[] = [];
  const createdAt: Date = new Date();
  const lastUpdated: Date = new Date();
  const authorId: string = author.id;

  let copiedTimetable: Timetable | null = null;
  try {
    copiedTimetable = await timetableRepository
      .createQueryBuilder("timetable")
      .leftJoinAndSelect("timetable.sections", "section")
      .where("timetable.id = :id", { id: dbID[0] })
      .getOne();
  } catch (err: any) {
    logger.error("Error while querying for timetable: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!copiedTimetable) {
    return res
      .status(404)
      .json({ message: "timetable to be copied not found" });
  }

  if (copiedTimetable.archived) {
    return res
      .status(400)
      .json({ message: "timetable is archived. cannot copy old timetables" });
  }

  timings = copiedTimetable.timings;
  examTimes = copiedTimetable.examTimes;
  warnings = copiedTimetable.warnings;

  try {
    const timetable = await timetableRepository
      .createQueryBuilder()
      .insert()
      .into(Timetable)
      .values({
        authorId,
        name,
        degrees,
        private: isPrivate,
        draft: isDraft,
        archived: isArchived,
        acadYear,
        semester,
        year,
        sections,
        timings,
        examTimes,
        warnings,
        createdAt,
        lastUpdated,
      })
      .execute();
    try {
      let section: Section | null = null;
      for (let i = 0; i < copiedTimetable.sections.length; i++) {
        section = copiedTimetable.sections[i];
        await timetableRepository
          .createQueryBuilder()
          .relation(Timetable, "sections")
          .of(timetable.identifiers[0].id)
          .add(section);
      }
    } catch (err: any) {
      logger.error(
        "Error while copying sections into new timetable: ",
        err.message,
      );

      return res.status(500).json({ message: "Internal Server Error" });
    }

    const timetableID = sqids.encode([timetable.identifiers[0].id]);
    return res.status(201).json({
      message: "Timetable copied successfully",
      id: timetableID,
    });
  } catch (err: any) {
    logger.error("Error while copying timetable: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }
};
