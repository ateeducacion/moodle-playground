import { phpLogin, phpSetAdminAccount } from "../php/helpers.js";

/**
 * Install-related steps: installMoodle, setAdminAccount, login.
 */

export function registerMoodleInstallSteps(register) {
  register("installMoodle", handleInstallMoodle);
  register("setAdminAccount", handleSetAdminAccount);
  register("login", handleLogin);
}

/**
 * installMoodle is a declarative marker. The actual install happens in
 * bootstrap.js via the existing CLI install / snapshot mechanism.
 * The step's options are extracted by buildInstallConfig() before execution.
 */
async function handleInstallMoodle(_step, _context) {
  // No-op — install already completed by bootstrap.js stage 3.
}

async function handleSetAdminAccount(step, { php, webRoot }) {
  const code = phpSetAdminAccount({
    username: step.username,
    password: step.password,
    email: step.email,
    firstname: step.firstname,
    lastname: step.lastname,
  });

  await writeAndRun(php, webRoot, code);
}

async function handleLogin(step, { php, webRoot }) {
  const username = step.username || "admin";
  const code = phpLogin(username);
  const scriptPath = `${webRoot || "/www/moodle"}/__blueprint_login.php`;

  await php.writeFile(scriptPath, new TextEncoder().encode(code));
  try {
    const response = await php.request(
      new Request("http://localhost:8080/__blueprint_login.php"),
    );
    const text = await response.text();
    if (response.status !== 200 || !text.includes('"ok"')) {
      throw new Error(
        `Login failed for user '${username}': status=${response.status}`,
      );
    }
  } finally {
    try {
      await php.run(`<?php @unlink('${scriptPath.replaceAll("'", "\\'")}');`);
    } catch {
      /* non-fatal */
    }
  }
}

async function writeAndRun(php, webRoot, code) {
  const scriptPath = `${webRoot || "/www/moodle"}/__blueprint_step.php`;
  await php.writeFile(scriptPath, new TextEncoder().encode(code));
  try {
    const result = await php.run(code);
    if (result.errors) {
      console.warn("[blueprint] Step PHP errors:", result.errors);
    }
    return result;
  } finally {
    try {
      await php.run(`<?php @unlink('${scriptPath.replaceAll("'", "\\'")}');`);
    } catch {
      /* non-fatal */
    }
  }
}
