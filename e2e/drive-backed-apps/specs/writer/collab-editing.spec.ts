import type { Page, Request, WebSocket } from "@playwright/test";
import { expect, test } from "../../fixtures/test";
import {
	collabState,
	compactNow,
	editorBlocks,
	expectConverged,
	expectSaved,
	openForCollab,
	serverBlocks,
	typeParagraph,
} from "../../helpers/collab";
import { discardNode } from "../../helpers/drive";
import {
	createWriterDocument,
	openWriterDocument,
	uniqueWriterTitle,
	writerEditor,
} from "../../helpers/writer";

test.describe("Writer collaboration", () => {
	let node = "";

	test.beforeEach(async ({ owner, collaborator, run, testApi }, testInfo) => {
		const title = uniqueWriterTitle(run.run_id, `collab ${testInfo.title}`);
		node = (await createWriterDocument(owner.page.request, title)).name;
		await openForCollab(testApi, owner.page.request, node, collaborator.user.user);
	});

	test.afterEach(async ({ owner }) => {
		await discardNode(owner.context.request, node);
	});

	test("two people typing at once end with the same document", async ({
		owner,
		collaborator,
		testApi,
	}) => {
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);

		await Promise.all([
			typeParagraph(owner.page, "Owner wrote this line"),
			typeParagraph(collaborator.page, "Collaborator wrote this line"),
		]);
		await expectSaved(owner.page);
		await expectSaved(collaborator.page);

		await expectConverged(
			testApi,
			node,
			[owner.page, collaborator.page],
			["Owner wrote this line", "Collaborator wrote this line"],
		);
	});

	test("reloading a tab keeps every edit", async ({ owner, collaborator, testApi }) => {
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);
		await typeParagraph(owner.page, "Kept across a reload");
		await typeParagraph(collaborator.page, "Also kept across a reload");
		await expectSaved(owner.page);
		await expectSaved(collaborator.page);
		const convergedBlocks = await expectConverged(
			testApi,
			node,
			[owner.page, collaborator.page],
			["Kept across a reload", "Also kept across a reload"],
		);

		await owner.page.reload();
		await openWriterDocument(owner.page, node);

		await expect.poll(() => editorBlocks(owner.page)).toEqual(convergedBlocks);
	});

	test("an edit reaches the other tab over the realtime socket, without a poll", async ({
		owner,
		collaborator,
	}) => {
		const frames: string[] = [];
		const recordFrames = (socket: WebSocket) => {
			socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
		};
		collaborator.page.on("websocket", recordFrames);

		const polls: string[] = [];
		const recordPoll = (request: Request) => {
			if (/\/api\/suite\/content\/[^/]+\/updates/.test(request.url())) {
				polls.push(request.url());
			}
		};
		collaborator.page.on("request", recordPoll);
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);
		await expect.poll(() => frames.some((frame) => frame.includes('"roster"'))).toBe(true);
		await typeParagraph(collaborator.page, "Collaborator is here");
		await expect(writerEditor(owner.page)).toContainText("Collaborator is here");

		polls.length = 0;
		await typeParagraph(owner.page, "Heard live");

		await expect(writerEditor(collaborator.page)).toContainText("Heard live", { timeout: 3000 });
		// Longer than one poll tick
		await collaborator.page.waitForTimeout(6000);
		expect(frames.some((frame) => frame.includes("suite_collab_row"))).toBe(true);
		expect(polls).toEqual([]);
	});

	test("each tab shows the other person's name, in the users bar and at their caret", async ({
		owner,
		collaborator,
		run,
	}) => {
		const nameOf = (user: { user: string }) =>
			`Drive Writer E2E ${run.users.findIndex((each) => each.user === user.user) + 1}`;
		const caretLabels = (page: Page) => page.locator(".collaboration-carets__label");
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);

		await typeParagraph(owner.page, "Owner's caret");
		await typeParagraph(collaborator.page, "Collaborator's caret");

		await expect(
			owner.page.getByRole("button", { name: `${nameOf(collaborator.user)} is here` }),
		).toBeVisible();
		await expect(
			collaborator.page.getByRole("button", { name: `${nameOf(owner.user)} is here` }),
		).toBeVisible();
		await expect(caretLabels(owner.page)).toHaveText([nameOf(collaborator.user)]);
		await expect(caretLabels(collaborator.page)).toHaveText([nameOf(owner.user)]);
	});

	test("compaction leaves the document unchanged, for an open tab and a late joiner", async ({
		owner,
		collaborator,
		testApi,
	}) => {
		await openWriterDocument(owner.page, node);
		await typeParagraph(owner.page, "Written before compaction");
		await typeParagraph(owner.page, "Second line before compaction");
		await expectSaved(owner.page);
		const writtenBlocks = await expectConverged(
			testApi,
			node,
			[owner.page],
			["Written before compaction", "Second line before compaction"],
		);
		const uncompactedState = await collabState(testApi, node);
		expect(uncompactedState.head_rev).toBeGreaterThan(uncompactedState.body_rev);

		const compacted = await compactNow(testApi, node);

		expect(compacted).toEqual({
			body_rev: uncompactedState.head_rev,
			head_rev: uncompactedState.head_rev,
			tail_rows: 0,
		});
		expect(await serverBlocks(testApi, node)).toEqual(writtenBlocks);

		await openWriterDocument(collaborator.page, node);
		await expect.poll(() => editorBlocks(collaborator.page)).toEqual(writtenBlocks);
		await expect.poll(() => editorBlocks(owner.page)).toEqual(writtenBlocks);

		await typeParagraph(collaborator.page, "Written after compaction");
		await expectSaved(collaborator.page);
		await expectConverged(
			testApi,
			node,
			[owner.page, collaborator.page],
			["Written before compaction", "Written after compaction"],
		);
	});

	test("edits made offline reach everyone after reconnecting", async ({
		owner,
		collaborator,
		testApi,
	}) => {
		// A failed pull retries after up to 30 s, so reconnecting can take that long
		test.setTimeout(120_000);
		await openWriterDocument(owner.page, node);
		await openWriterDocument(collaborator.page, node);

		await collaborator.context.setOffline(true);
		await typeParagraph(collaborator.page, "Typed while offline");
		await typeParagraph(owner.page, "Typed while the other tab was offline");
		await expectSaved(owner.page);
		await expect(collaborator.page.getByText("Saved", { exact: true })).toBeHidden();

		await collaborator.context.setOffline(false);

		await expectConverged(
			testApi,
			node,
			[owner.page, collaborator.page],
			["Typed while offline", "Typed while the other tab was offline"],
			60_000,
		);
	});

	test("closing the last tab compacts, and the document then opens from the checkpoint", async ({
		owner,
		collaborator,
		testApi,
	}) => {
		await openWriterDocument(owner.page, node);
		await typeParagraph(owner.page, "Typed just before the last tab closed");

		// Closing with the edit still unsent sends it as the tab's final push, which asks for a compaction
		await owner.page.close();

		const compactionStatus = async () => {
			const state = await collabState(testApi, node);
			const compacted = state.head_rev > 0 && state.body_rev === state.head_rev;
			return {
				compacted,
				tail_rows: state.tail_rows,
			};
		};
		await expect
			.poll(compactionStatus, { timeout: 30_000 })
			.toEqual({ compacted: true, tail_rows: 0 });
		const stored = await serverBlocks(testApi, node);
		expect(stored.join("\n")).toContain("Typed just before the last tab closed");

		await openWriterDocument(collaborator.page, node);
		await expect.poll(() => editorBlocks(collaborator.page)).toEqual(stored);
	});
});
