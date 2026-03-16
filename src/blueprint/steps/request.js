/**
 * Low-level request step handlers: request, runPhpCode, runPhpScript.
 */

export function registerRequestSteps(register) {
  register("request", handleRequest);
  register("runPhpCode", handleRunPhpCode);
  register("runPhpScript", handleRunPhpScript);
}

async function handleRequest(step, { php }) {
  const url = step.url || "http://localhost:8080/";
  const method = step.method || "GET";
  const headers = step.headers || {};
  const body = step.body || undefined;

  const init = { method, headers };
  if (body && !["GET", "HEAD"].includes(method)) {
    init.body = body;
  }

  const response = await php.request(new Request(url, init));
  const text = await response.text();

  if (step.expectOk !== false && response.status >= 400) {
    throw new Error(
      `Request to ${url} returned status ${response.status}: ${text.substring(0, 200)}`,
    );
  }
}

async function handleRunPhpCode(step, { php }) {
  if (!step.code) throw new Error("runPhpCode: 'code' is required.");

  const code = step.code.startsWith("<?php")
    ? step.code
    : `<?php\n${step.code}`;
  const result = await php.run(code);

  if (result.errors) {
    console.warn("[blueprint] runPhpCode errors:", result.errors);
  }
}

async function handleRunPhpScript(step, { php, webRoot }) {
  if (!step.code) throw new Error("runPhpScript: 'code' is required.");

  const tmpPath = `${webRoot || "/www/moodle"}/__blueprint_tmp_script.php`;
  const code = step.code.startsWith("<?php")
    ? step.code
    : `<?php\n${step.code}`;

  await php.writeFile(tmpPath, new TextEncoder().encode(code));
  try {
    const response = await php.request(
      new Request("http://localhost:8080/__blueprint_tmp_script.php"),
    );
    const text = await response.text();

    if (step.expectOk !== false && response.status >= 400) {
      throw new Error(
        `runPhpScript returned status ${response.status}: ${text.substring(0, 200)}`,
      );
    }
  } finally {
    try {
      await php.run(`<?php @unlink('${tmpPath.replaceAll("'", "\\'")}');`);
    } catch {
      /* non-fatal */
    }
  }
}
