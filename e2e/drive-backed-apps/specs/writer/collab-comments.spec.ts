import type { Page } from "@playwright/test";

import { expect, test } from "../../fixtures/test";
import { openForCollab } from "../../helpers/collab";
import { discardNode } from "../../helpers/drive";
import {
	createWriterDocument,
	openWriterDocument,
	uniqueWriterTitle,
} from "../../helpers/writer";

async function openComments(page: Page) {
	await page.getByRole("banner").getByRole("button", { name: "Comments", exact: true }).click();
	return page.getByRole("complementary", { name: "Comments" });
}

async function commentOnDocument(page: Page, text: string) {
	const panel = await openComments(page);
	await panel.getByLabel("New comment").fill(text);
	await panel.getByRole("button", { name: "Add" }).click();
	return panel;
}

test.describe("Writer collaboration comments", () => {
	let node = "";

	test.beforeEach(async ({ owner, collaborator, run, testApi }, testInfo) => {
		const title = uniqueWriterTitle(run.run_id, `comments ${testInfo.title}`);
		node = (await createWriterDocument(owner.page.request, title)).name;
		await openForCollab(testApi, owner.page.request, node, collaborator.user.user);
	});

	test.afterEach(async ({ owner }) => {
		await discardNode(owner.context.request, node);
	});

	test("a comment on the document shows in its group and takes a reply, resolve, reopen and delete", async ({
		owner,
	}) => {
		const { page } = owner;
		await openWriterDocument(page, node);
		const panel = await commentOnDocument(page, "Whole document note");
		const group = panel.getByRole("region", { name: "Comments on the document" });
		await expect(group).toContainText("Whole document note");

		await group.getByRole("button", { name: "Reply" }).click();
		await group.getByLabel("Reply").fill("A reply");
		await group.getByRole("button", { name: "Send" }).click();
		await expect(group).toContainText("A reply");
		await group.getByRole("button", { name: "Resolve" }).click();
		await expect(group.getByRole("button", { name: "Reopen" })).toBeVisible();
		await group.getByRole("button", { name: "Reopen" }).click();
		await expect(group.getByRole("button", { name: "Resolve" })).toBeVisible();

		for (let left = 2; left > 0; left--) {
			await group.getByRole("button", { name: "Delete comment" }).first().click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
			await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(left - 1);
		}

		await expect(panel.getByText("No comments yet.")).toBeVisible();
	});

	test("another tab's comment shows in an open panel without reopening it", async ({
		owner,
		collaborator,
	}) => {
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);
		const watching = await openComments(collaborator.page);
		await expect(watching.getByText("No comments yet.")).toBeVisible();

		await commentOnDocument(owner.page, "Seen from the other tab");

		await expect(
			watching.getByRole("region", { name: "Comments on the document" }),
		).toContainText("Seen from the other tab");
	});
});
