import type { Request, Response } from "express";
import { z } from "zod";
import {
  announcementType,
  namedNonEmptyStringType,
} from "../../../../lib/src/index.js";
import { env } from "../../config/server.js";
import { Announcement } from "../../entity/entities.js";
import { validate } from "../../middleware/zodValidateRequest.js";
import { announcementRepository } from "../../repositories/announcementRepository.js";

const announcementSchema = z.object({
  body: announcementType.extend({
    chronoSecret: namedNonEmptyStringType("chronoSecret"),
  }),
});

export const announcementValidator = validate(announcementSchema);

export const createAnnouncement = async (req: Request, res: Response) => {
  const logger = req.log;
  try {
    const { title, message } = req.body;

    if (env.CHRONO_SECRET !== req.body.chronoSecret) {
      return res.status(401).json({ message: "Chrono Secret is incorrect" });
    }

    await announcementRepository
      .createQueryBuilder()
      .insert()
      .into(Announcement)
      .values({
        title,
        message,
      })
      .execute();

    return res
      .status(201)
      .json({ message: "Announcement Created Successfully" });
  } catch (err: any) {
    logger.error("Error creating announcement: ", err.message);

    return res.status(500).json({ message: "Internal Server Error" });
  }
};
