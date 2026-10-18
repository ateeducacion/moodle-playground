import { expect, test } from "./fixtures.mjs";
import {
  findMoodleFrame,
  specTimeoutMs,
  waitForMoodleContent,
  waitForPlaygroundReady,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs + 120_000 });

const blueprint = Buffer.from(
  JSON.stringify({
    steps: [
      { step: "installMoodle", options: { locale: "en" } },
      {
        step: "writeFiles",
        files: [
          {
            path: "/www/moodle/public/ownership.php",
            data: `<?php
$file='/persist/ownership-counter';
$count=is_file($file)?(int)file_get_contents($file):0;
if ($_SERVER['REQUEST_METHOD']==='POST') file_put_contents($file,(string)++$count);
header('Content-Type: application/json');
echo json_encode(['count'=>$count,'php'=>PHP_VERSION]);`,
          },
        ],
      },
    ],
  }),
).toString("base64");

function url(scope, php = "8.3") {
  return `./?scope=${scope}&php=${php}&blueprint=${encodeURIComponent(blueprint)}`;
}

async function postAndObserve(page, scope) {
  return findMoodleFrame(page).evaluate(async (scope) => {
    const channel = new BroadcastChannel(`moodle-playground-php:${scope}`);
    const replies = [];
    let requestId;
    channel.onmessage = ({ data }) => {
      if (
        data.kind === "http-request" &&
        data.request.url.includes("ownership.php")
      )
        requestId = data.id;
      if (data.kind === "http-response" && data.id === requestId)
        replies.push(JSON.parse(new TextDecoder().decode(data.response.body)));
    };
    const response = await fetch(
      `/playground/${scope}/php83-moodle53/ownership.php`,
      { method: "POST", body: new URLSearchParams({ increment: "1" }) },
    );
    const result = await response.json();
    // Observe duplicate replies after the first HTTP response has won the race.
    await new Promise((resolve) => setTimeout(resolve, 500));
    channel.close();
    return { result, replies, requestId };
  }, scope);
}

for (const php of ["8.3", "8.4"]) {
  test(`one owner executes POST when a second tab shares the scope with PHP ${php}`, async ({
    page,
    context,
  }) => {
    const scope = `ownership-${crypto.randomUUID()}`;
    await page.goto(url(scope));
    await waitForPlaygroundReady(page);
    const second = await context.newPage();
    await second.goto(url(scope, php));
    // On the broken implementation the second worker boots; on the fixed
    // implementation it reports the ownership conflict without starting PHP.
    await expect
      .poll(
        async () => {
          const status = await second
            .frameLocator("#site-frame")
            .locator("#remote-status")
            .textContent();
          return (
            status.includes("already open") ||
            status.includes(`Moodle bootstrapped for PHP ${php}`)
          );
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    const post = await postAndObserve(page, scope);
    expect(post.replies).toHaveLength(1);
    expect(post.result.count).toBe(1);
    await expect(
      second.frameLocator("#site-frame").locator("#remote-status"),
    ).toContainText("already open");
    expect(second.workers()).toHaveLength(0);
    await expect(page.locator("#address-input")).toBeEnabled();

    await page
      .locator("#site-frame")
      .evaluate((frame) =>
        frame.contentWindow.postMessage(
          { kind: "flush-persistence" },
          location.origin,
        ),
      );
    await expect(page.locator("#log-panel")).toContainText(
      "Persistence journal flushed",
    );
    await page.close();
    await second.reload();
    await waitForPlaygroundReady(second);
    const retained = await findMoodleFrame(second).evaluate(
      async ({ scope, php, oldId }) => {
        const channel = new BroadcastChannel(`moodle-playground-php:${scope}`);
        channel.onmessage = ({ data }) => {
          if (data.kind === "http-request")
            channel.postMessage({
              kind: "http-response",
              id: oldId,
              response: {
                status: 200,
                headers: {},
                body: new TextEncoder().encode('{"count":999}'),
              },
            });
        };
        const response = await fetch(
          `/playground/${scope}/php${php.replace(".", "")}-moodle53/ownership.php`,
        );
        const result = await response.json();
        channel.close();
        return result;
      },
      { scope, php, oldId: post.requestId },
    );
    expect(retained.count).toBe(1);
    expect(retained.php).toMatch(new RegExp(`^${php.replace(".", "\\.")}`));
  });
}

test("distinct scopes own independent PHP workers", async ({
  page,
  context,
}) => {
  const scope = `independent-${crypto.randomUUID()}`;
  await page.goto(url(scope));
  await waitForPlaygroundReady(page);
  await expect(
    page.frameLocator("#site-frame").locator("#progress-percent"),
  ).toHaveText("100%");
  const second = await context.newPage();
  const otherScope = `independent-${crypto.randomUUID()}`;
  await second.goto(url(otherScope));
  await waitForPlaygroundReady(second);
  expect((await postAndObserve(page, scope)).result.count).toBe(1);
  expect((await postAndObserve(second, otherScope)).result.count).toBe(1);
  await second
    .locator("#site-frame")
    .evaluate((frame) =>
      frame.contentWindow.postMessage(
        { kind: "flush-persistence" },
        location.origin,
      ),
    );
  await expect(second.locator("#log-panel")).toContainText(
    "Persistence journal flushed",
  );
  await second.reload();
  await waitForShellReady(second);
  await waitForMoodleContent(() => findMoodleFrame(second), ["#page"]);
  const readCount = () =>
    findMoodleFrame(second).evaluate(
      async () => (await (await fetch("../ownership.php")).json()).count,
    );
  expect(await readCount()).toBe(1);
  const previousFrame = findMoodleFrame(second);
  await second.locator("#panel-toggle-button").click();
  await second.locator("#reset-button").click();
  await expect.poll(() => previousFrame.isDetached()).toBe(true);
  await waitForPlaygroundReady(second);
  expect(await readCount()).toBe(0);
  await second.locator("#info-php-version").selectOption("8.4");
  await second.locator("#config-apply").click();
  await waitForPlaygroundReady(second);
  await expect(second.locator("#runtime-id-value")).toHaveText(
    "php84-moodle53",
  );
  expect(await readCount()).toBe(0);
  // Resetting one owner must not touch the other scope's persisted/runtime data.
  expect(
    await findMoodleFrame(page).evaluate(
      async () => (await (await fetch("../ownership.php")).json()).count,
    ),
  ).toBe(1);
});
