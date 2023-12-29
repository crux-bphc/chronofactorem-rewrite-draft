/*
These are the types that facilitate authentication
*/
import { z } from "zod";
import {
  namedDegreeZodList,
  namedEmailType,
  namedIntegerType,
  namedNonEmptyStringType,
  namedUUIDType,
} from "../../../lib";

// interface for userdata to be stored in the session cookie and for validating the type of session cookie
export const ZodUnfinishedUserSession = z.object({
  name: namedNonEmptyStringType("name"),
  email: namedEmailType(),
  maxAge: namedIntegerType("maxAge"),
});

export type UnfinishedUserSession = z.infer<typeof ZodUnfinishedUserSession>;

export const ZodFinishedUserSession = z.object({
  name: namedNonEmptyStringType("name"),
  email: namedEmailType(),
  id: namedUUIDType("user id"),
});
export type FinishedUserSession = z.infer<typeof ZodFinishedUserSession>;

export const ZodSignUpUserData = z.object({
  name: namedNonEmptyStringType("name"),
  email: namedEmailType(),
  degrees: namedDegreeZodList("user"),
});
export type SignUpUserData = z.infer<typeof ZodSignUpUserData>;