import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../../fixtures/test";
import { expectSaved, openForCollab, saveNamedVersion, typeParagraph } from "../../helpers/collab";
import { discardNode } from "../../helpers/drive";
import {
	createWriterDocument,
	openWriterDocument,
	uniqueWriterTitle,
	writerEditor,
} from "../../helpers/writer";

async function openComments(page: Page) {
	await page.getByRole("banner").getByRole("button", { name: "Comments", exact: true }).click();
	return page.getByRole("complementary", { name: "Comments" });
}

async function commentOnDocument(page: Page, text: string) {
	const panel = await openComments(page);
	await panel.getByRole("button", { name: "Comment on the whole document…" }).click();
	await panel.getByLabel("New comment").fill(text);
	await panel.getByRole("button", { name: "Comment", exact: true }).click();
	return panel;
}

// A thread's row in the list, by any of its words
function threadRow(panel: Locator, text: string) {
	return panel.getByRole("listitem").filter({ hasText: text });
}

// Types a line, selects its last word and starts a comment on it from the bubble menu
async function startCommentOnLastWord(page: Page, line: string) {
	await typeParagraph(page, line);
	await expectSaved(page);
	const word = line.split(" ").at(-1) ?? "";
	for (let left = word.length; left > 0; left--) {
		await page.keyboard.press("Shift+ArrowLeft");
	}

	await page.locator('[data-slot="bubble-menu"]').getByRole("button", { name: "Comment" }).click();
	const drafts = page.getByRole("complementary", { name: "Comments" }).getByRole("region", {
		name: "Not posted yet",
	});
	await expect(drafts).toContainText(word);
	return drafts;
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

	test("a comment on the document shows on its row and takes a reply, resolve, reopen and delete", async ({
		owner,
	}) => {
		const { page } = owner;
		await openWriterDocument(page, node);
		const panel = await commentOnDocument(page, "Whole document note");
		const row = threadRow(panel, "Whole document note");
		await expect(row).toContainText("Whole document");

		await row.getByRole("button", { name: /Whole document note/ }).click();
		await row.getByRole("button", { name: "Reply" }).click();
		await row.getByLabel("Reply").fill("A reply");
		await row.getByRole("button", { name: "Send" }).click();
		await expect(row).toContainText("A reply");
		await row.getByRole("button", { name: "Resolve" }).click();
		await expect(row).toHaveCount(0);
		await panel.getByRole("radio", { name: "Resolved 1" }).click();
		await row.getByRole("button", { name: /Whole document note/ }).click();
		await row.getByRole("button", { name: "Reopen" }).click();
		await panel.getByRole("radio", { name: "Open 1" }).click();
		await row.getByRole("button", { name: /Whole document note/ }).click();

		for (let left = 2; left > 0; left--) {
			await panel.getByRole("button", { name: "Delete comment" }).first().click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
			await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(left - 1);
		}

		await expect(panel.getByText("No open comments.", { exact: false })).toBeVisible();
	});

	test("another tab's comment shows in an open panel without reopening it", async ({
		owner,
		collaborator,
	}) => {
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);
		const watching = await openComments(collaborator.page);
		await expect(watching.getByText("No open comments.", { exact: false })).toBeVisible();

		await commentOnDocument(owner.page, "Seen from the other tab");

		await expect(threadRow(watching, "Seen from the other tab")).toContainText("Whole document");
	});

	test("a comment on selected text shows on its words, and with deleted text once they go", async ({
		owner,
	}) => {
		const { page } = owner;
		await openWriterDocument(page, node);
		const drafts = await startCommentOnLastWord(page, "the commented sentence");

		await drafts.getByLabel("Comment on the text").fill("About this word");
		await drafts.getByRole("button", { name: "Comment" }).click();

		const panel = page.getByRole("complementary", { name: "Comments" });
		const row = threadRow(panel, "About this word");
		await expect(row).not.toContainText("Text deleted");
		await expect(drafts).toHaveCount(0);
		await expect(writerEditor(page).locator("[data-thread]")).toHaveText("sentence");

		await writerEditor(page).locator("[data-thread]").dblclick();
		await page.keyboard.press("Backspace");
		await expect(row).toContainText("Text deleted");
		await row.getByRole("button", { name: /About this word/ }).click();
		await expect(row).toContainText("sentence");
	});

	test("restoring a version puts a comment back on the words it brought back, for good", async ({
		owner,
	}) => {
		const { page } = owner;
		await openWriterDocument(page, node);
		const drafts = await startCommentOnLastWord(page, "the commented sentence");
		await drafts.getByLabel("Comment on the text").fill("About this word");
		await drafts.getByRole("button", { name: "Comment" }).click();
		const panel = page.getByRole("complementary", { name: "Comments" });
		await expect(threadRow(panel, "About this word")).not.toContainText("Text deleted");
		await saveNamedVersion(owner.context.request, node, "With the word");
		await writerEditor(page).locator("[data-thread]").dblclick();
		await page.keyboard.press("Backspace");
		await expect(threadRow(panel, "About this word")).toContainText("Text deleted");
		await expectSaved(page);

		await page.getByRole("button", { name: /versions/i }).first().click();
		await page.getByRole("complementary", { name: "Versions" }).getByRole("button", { name: /^With the word/ }).click();
		await page.getByRole("button", { name: "Restore", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
		await expect(page.getByText("Version restored")).toBeVisible();

		await expect(writerEditor(page).locator("[data-thread]")).toHaveText("sentence");
		await page.reload();
		await expect(writerEditor(page).locator("[data-thread]")).toHaveText("sentence");
		const reopened = await openComments(page);
		await expect(threadRow(reopened, "About this word")).toBeVisible();
		await expect(threadRow(reopened, "About this word")).not.toContainText("Text deleted");
	});

	test("an unposted comment stays on the device through a reload until discarded", async ({
		owner,
	}) => {
		const { page } = owner;
		await openWriterDocument(page, node);
		const drafts = await startCommentOnLastWord(page, "kept for later");
		await drafts.getByLabel("Comment on the text").fill("Not sent yet");

		await page.reload();
		const reopened = (await openComments(page)).getByRole("region", { name: "Not posted yet" });
		await expect(reopened.getByLabel("Comment on the text")).toHaveValue("Not sent yet");

		await reopened.getByRole("button", { name: "Cancel" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
		await expect(reopened).toHaveCount(0);
		await page.reload();
		await expect((await openComments(page)).getByText("No open comments.", { exact: false })).toBeVisible();
	});
});
