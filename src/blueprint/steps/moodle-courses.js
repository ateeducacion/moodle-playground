import {
  phpCreateCourse,
  phpCreateCourses,
  phpCreateSection,
  phpCreateSections,
} from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";

export function registerMoodleCourseSteps(register) {
  register("createCourse", handleCreateCourse);
  register("createCourses", handleCreateCourses);
  register("createSection", handleCreateSection);
  register("createSections", handleCreateSections);
}

async function handleCreateCourse(step, { php }) {
  if (!step.fullname || !step.shortname) {
    throw new Error("createCourse: 'fullname' and 'shortname' are required.");
  }
  const code = phpCreateCourse(step);
  const result = await php.run(code);
  checkPhpResult(result, "createCourse");
}

async function handleCreateCourses(step, { php }) {
  if (!Array.isArray(step.courses))
    throw new Error("createCourses: 'courses' must be an array.");
  const code = phpCreateCourses(step.courses);
  const result = await php.run(code);
  checkPhpResult(result, "createCourses");
}

async function handleCreateSection(step, { php }) {
  if (!step.course) throw new Error("createSection: 'course' is required.");
  const code = phpCreateSection(step);
  const result = await php.run(code);
  checkPhpResult(result, "createSection");
}

async function handleCreateSections(step, { php }) {
  if (!Array.isArray(step.sections))
    throw new Error("createSections: 'sections' must be an array.");
  const code = phpCreateSections(step.sections);
  const result = await php.run(code);
  checkPhpResult(result, "createSections");
}
