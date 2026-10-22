import { execFileSync } from "node:child_process";

import type { Browser, BrowserContext } from "@playwright/test";

import { loginViaApi } from "../../shared/auth";

import type { Flips } from "./flips";

// A System User that exists on the test site. Grants to it send no email: the
// bench runs no worker, and the address is not a real mailbox.
export const PERSON = "backfill-owner@example.com";
const PERSON_PASSWORD = "ShareJourney!2026";

/** Gives PERSON a password through the bench interpreter, so a journey can sign in as a non-admin. */
function setPersonPassword() {
	const bench = process.env.BENCH_PATH ?? "/home/faris/benches/suite-bench";
	const site = process.env.BENCH_SITE ?? "slides.localhost";
	const program = [
		"import frappe",
		"from frappe.utils.password import update_password",
		`frappe.init(site=${JSON.stringify(site)})`,
		"frappe.connect()",
		`update_password(${JSON.stringify(PERSON)}, ${JSON.stringify(PERSON_PASSWORD)})`,
		"frappe.db.commit()",
		"frappe.destroy()",
	].join("\n");
	execFileSync(`${bench}/env/bin/python`, ["-c", program], { cwd: `${bench}/sites` });
}

/** A browser context signed in as PERSON, with the journey's flips. The caller closes it. */
export async function personContext(browser: Browser, baseURL: string, flips: Flips): Promise<BrowserContext> {
	setPersonPassword();
	const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
	await context.addInitScript((value) => Object.assign(window, value), flips);
	await loginViaApi(context.request, { email: PERSON, password: PERSON_PASSWORD });
	return context;
}
