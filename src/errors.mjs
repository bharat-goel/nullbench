// Split out of prereg.mjs so src/skill.mjs can throw the same error without a circular
// import (prereg.mjs resolves the skill via skill.mjs; skill.mjs needs this class).

export class RegistrationError extends Error {
  constructor(problems) {
    super(`registration is not executable:\n  - ${problems.join("\n  - ")}`);
    this.name = "RegistrationError";
    this.problems = problems;
  }
}
