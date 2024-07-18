import "dotenv/config";
import { Request, Response } from "express";
import { z } from "zod";
import {
  namedBooleanType,
  namedNonEmptyStringType,
  timetableIDType,
} from "../../../../lib/src/index.js";
import { env } from "../../config/server.js";
import { Timetable, User } from "../../entity/entities.js";
import { validate } from "../../middleware/zodValidateRequest.js";
import { timetableRepository } from "../../repositories/timetableRepository.js";
import { userRepository } from "../../repositories/userRepository.js";
import sqids, { validSqid } from "../../utils/sqids.js";

const dataSchema = z.object({
  body: z.object({
    name: namedNonEmptyStringType("timetable name"),
    isPrivate: namedBooleanType("timetable isPrivate"),
    isDraft: namedBooleanType("timetable isDraft"),
  }),
  params: z.object({
    id: timetableIDType,
  }),
});

export const editTimetableMetadataValidator = validate(dataSchema);

export const editTimetableMetadata = async (req: Request, res: Response) => {
  let author: User | null = null;

  const name: string = req.body.name;
  const isPrivate: boolean = req.body.isPrivate;
  const isDraft: boolean = req.body.isDraft;

  try {
    author = await userRepository
      .createQueryBuilder("user")
      .where("user.id = :id", { id: req.session?.id })
      .getOne();
  } catch (err: any) {
    // will replace the console.log with a logger when we have one
    console.log("Error while querying user: ", err.message);
    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!author) {
    return res.status(401).json({ message: "unregistered user" });
  }

  if (isDraft && !isPrivate) {
    return res
      .status(400)
      .json({ message: "draft timetable can not be public" });
  }

  const dbID = sqids.decode(req.params.id);
  if (!validSqid(dbID)) {
    return res.status(404).json({ message: "Timetable does not exist" });
  }

  let timetable: Timetable | null = null;

  try {
    timetable = await timetableRepository
      .createQueryBuilder("timetable")
      .leftJoinAndSelect("timetable.sections", "section")
      .where("timetable.id = :id", { id: dbID[0] })
      .getOne();
  } catch (err: any) {
    // will replace the console.log with a logger when we have one
    console.log("Error while querying timetable: ", err.message);
    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (!timetable) {
    return res.status(404).json({ message: "timetable not found" });
  }

  if (timetable.authorId !== author.id) {
    return res.status(403).json({ message: "user does not own timetable" });
  }

  if (timetable.archived && isDraft) {
    return res
      .status(418)
      .json({ message: "archived timetable can not be a draft" });
  }

  if (
    timetable.draft &&
    timetable.sections.length === 0 &&
    (isDraft === false || isPrivate === false)
  ) {
    return res.status(400).json({
      message: "cannot publish empty timetable",
    });
  }

  if (
    timetable.warnings.length > 0 &&
    (isDraft === false || isPrivate === false)
  ) {
    return res.status(400).json({
      message: "cannot publish timetable with warnings",
    });
  }
  let updatedTimetable;
  try {
    updatedTimetable = await timetableRepository.save({
      ...timetable,
      name: name,
      private: isPrivate,
      draft: isDraft,
    });
  } catch (err: any) {
    // will replace the console.log with a logger when we have one
    console.log("Error while editing timetable: ", err.message);
    return res.status(500).json({ message: "Internal Server Error" });
  }

  if (isDraft === false && isPrivate === false) {
    try {
      const searchServiceURL = `${env.SEARCH_SERVICE_URL}/timetable/add`;
      const updatedTimetableStringID = {
        ...updatedTimetable,
        id: req.params.id,
      };
      const res = await fetch(searchServiceURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatedTimetableStringID),
      });
      const resJson = await res.json();
      if (!res.ok) {
        console.log(resJson.error);
      }
    } catch (err: any) {
      console.log(
        "Error while adding timetable to search service: ",
        err.message,
      );
      return res.status(500).json({ message: "Internal Server Error" });
    }
  } else {
    try {
      const searchServiceURL = `${env.SEARCH_SERVICE_URL}/timetable/remove`;

      const res = await fetch(searchServiceURL, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: req.params.id }),
      });
      if (!res.ok) {
        const resJson = await res.json();
        console.log(resJson.error);
      }
    } catch (err: any) {
      console.log(
        "Error while removing timetable from search service: ",
        err.message,
      );
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }

  return res.json({ message: "timetable edited" });
};
