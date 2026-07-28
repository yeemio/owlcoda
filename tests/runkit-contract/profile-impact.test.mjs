import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { resolveProfileImpact } from "../../scripts/runkit-contract/profile-impact.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cliPath = path.join(repositoryRoot, "scripts/runkit-contract/profile-impact.mjs")

const profiles = [
	{ id: "desktop-composer", paths: ["desktop/osui/src/renderer/components/task-composer.tsx"] },
	{ id: "desktop-profile", paths: ["desktop/osui/src/renderer/state/**"] },
	{ id: "root-runtime", paths: ["src/native/**", "package.json"] },
]

test("exact rules match only one path while directory/** matches descendants", () => {
	assert.deepEqual(resolveProfileImpact({
		changedPaths: [
			"desktop/osui/src/renderer/components/task-composer.tsx",
			"desktop/osui/src/renderer/state/labels.ts",
		],
		profiles,
	}), {
		decision: "targeted_profiles",
		profileIds: ["desktop-composer", "desktop-profile"],
		uncoveredPaths: [],
	})

	assert.deepEqual(resolveProfileImpact({
		changedPaths: ["desktop/osui/src/renderer/components/task-composer.tsx.bak"],
		profiles,
	}), {
		decision: "full_profile_required",
		profileIds: [],
		uncoveredPaths: ["desktop/osui/src/renderer/components/task-composer.tsx.bak"],
	})
})

test("profile ids and changed paths are deterministically deduplicated and sorted", () => {
	assert.deepEqual(resolveProfileImpact({
		changedPaths: ["src/native/session.ts", "package.json", "src/native/session.ts"],
		profiles: [
			{ id: "z-profile", paths: ["src/native/**"] },
			{ id: "a-profile", paths: ["package.json"] },
			{ id: "z-profile", paths: ["package.json"] },
		],
	}), {
		decision: "targeted_profiles",
		profileIds: ["a-profile", "z-profile"],
		uncoveredPaths: [],
	})
})

test("any uncovered path forces full_profile_required and lists every uncovered path", () => {
	assert.deepEqual(resolveProfileImpact({
		changedPaths: ["unknown/z.ts", "src/native/session.ts", "unknown/a.ts", "unknown/z.ts"],
		profiles,
	}), {
		decision: "full_profile_required",
		profileIds: [],
		uncoveredPaths: ["unknown/a.ts", "unknown/z.ts"],
	})
})

test("unsupported wildcard rules fail closed instead of being interpreted as broad matches", () => {
	assert.throws(
		() => resolveProfileImpact({ changedPaths: ["src/main.ts"], profiles: [{ id: "unsafe", paths: ["src/*.ts"] }] }),
		(error) => error instanceof Error && error.message === "Profile path rules support only exact paths and directory/**.",
	)
})

test("CLI accepts JSON on stdin and emits the same deterministic machine-readable decision", () => {
	const input = {
		changedPaths: ["desktop/osui/src/renderer/state/labels.ts"],
		profiles,
	}
	const result = spawnSync(process.execPath, [cliPath], {
		cwd: repositoryRoot,
		input: JSON.stringify(input),
		encoding: "utf8",
	})

	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.stderr, "")
	assert.deepEqual(JSON.parse(result.stdout), resolveProfileImpact(input))
})
