import { type APIRequestContext, expect, test } from "@playwright/test";

import { adminApi, createFolder, purge, roots, runTag, type DriveNode } from "../../helpers/drive";

/** Ticket 006: 60-row windows, opaque cursors and infinite loading. */

test.describe.configure({ mode: "serial" });

const TOTAL = 65;

let api: APIRequestContext;
let folder: DriveNode;

test.beforeAll(async ({ baseURL }) => {
	test.setTimeout(180_000);
	api = await adminApi(baseURL!);
	const personal = (await roots(api)).personal.node;
	folder = await createFolder(api, personal, runTag("w4-paging"));
	for (let start = 0; start < TOTAL; start += 5) {
		await Promise.all(
			Array.from({ length: Math.min(5, TOTAL - start) }, (_, offset) =>
				createFolder(api, folder.name, `row-${String(start + offset + 1).padStart(3, "0")}`),
			),
		);
	}
});

test.afterAll(async () => {
	await purge(api, folder.name);
	await api.dispose();
});

test("the listing loads the next window when the sentinel becomes visible", async ({ page }) => {
	await page.goto(`/drive/f/${folder.name}?view=list&sort=title&dir=asc`);
	const rows = page.locator("[data-node]");
	await expect(rows).toHaveCount(60, { timeout: 20_000 });

	// The sentinel loads on entering view. A background refresh can reset the
	// listing while it is already in view, so scroll it out and back, as a reader would.
	await expect(async () => {
		await rows.first().scrollIntoViewIfNeeded();
		await rows.last().scrollIntoViewIfNeeded();
		await expect(rows).toHaveCount(TOTAL, { timeout: 3_000 });
	}).toPass({ timeout: 20_000 });
	await expect(page.getByText("row-065", { exact: true })).toBeVisible();
});

test("changing the sort restarts the listing without a cursor", async ({ page }) => {
	await page.goto(`/drive/f/${folder.name}?view=list&sort=title&dir=asc`);
	const rows = page.locator("[data-node]");
	await expect(rows).toHaveCount(60, { timeout: 20_000 });
	await rows.last().scrollIntoViewIfNeeded();
	await expect(rows).toHaveCount(TOTAL, { timeout: 20_000 });

	const requests: string[] = [];
	page.on("request", (request) => {
		if (/\/children\?/.test(request.url())) requests.push(request.url());
	});

	await page.getByRole("button", { name: "Name" }).click();
	await expect(page).toHaveURL(/dir=desc/);
	await expect(rows).toHaveCount(60, { timeout: 20_000 });
	await expect(page.getByText("row-065", { exact: true })).toBeVisible();
	expect(requests.length).toBeGreaterThan(0);
	expect(requests.filter((url) => url.includes("cursor="))).toEqual([]);
});

// The walk stops at the first failed window (fixed here). Before the fix it
// retried the same cursor at 46 requests per 5 seconds.
test("a failed next window keeps the loaded rows and offers a retry", async ({ page }) => {
	await page.goto(`/drive/f/${folder.name}?view=list&sort=title&dir=asc`);
	const rows = page.locator("[data-node]");
	await expect(rows).toHaveCount(60, { timeout: 20_000 });

	let failed = 0;
	let failing = true;
	await page.route(/\/children\?.*cursor=/, (route) => {
		if (!failing) return route.continue();
		failed += 1;
		return route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({ errors: [{ type: "InternalServerError", message: "Injected failure" }] }),
		});
	});
	// As in the first test: a background refresh can reset the listing while the
	// sentinel is already in view, so scroll it out and back until a window fails.
	await expect(async () => {
		await rows.first().scrollIntoViewIfNeeded();
		await rows.last().scrollIntoViewIfNeeded();
		expect(failed, "a next-window request was sent and failed").toBeGreaterThan(0);
	}).toPass({ timeout: 20_000 });

	await expect(page.getByRole("button", { name: "Retry loading more" })).toBeVisible();
	await expect(rows).toHaveCount(60);
	await expect(page.getByText("Could not refresh files"), `failed next-window requests so far: ${failed}`).toBeVisible();

	// Bring the explicit retry into view while requests still fail.
	const retry = page.getByRole("button", { name: "Retry loading more" });
	await retry.scrollIntoViewIfNeeded();
	await expect(retry).toBeInViewport();
	failing = false;
	const nextWindow = page.waitForResponse((response) => /\/children\?.*cursor=/.test(response.url()) && response.ok());
	await retry.click();
	await nextWindow;
	await expect(rows).toHaveCount(TOTAL, { timeout: 20_000 });
});
