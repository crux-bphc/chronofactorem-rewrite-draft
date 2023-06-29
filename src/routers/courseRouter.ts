import * as express from "express";
import { getCourseById } from "../controllers/course/getCourseById";
import { getAllCourses } from "../controllers/course/getAllCourses";
import { getCourseByIdValidator } from "../controllers/course/getCourseById";

const courseRouter = express.Router();

courseRouter.get("/:id", getCourseById);
courseRouter.get("/", getAllCourses, getCourseByIdValidator);

export default courseRouter;
