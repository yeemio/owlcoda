import { isAbsolute, win32 } from "node:path"
import { isDirectExecution, isReservedRuntimePath } from "./core-contract.mjs"

const FULL_PROFILE_REQUIRED = "full_profile_required"
const TARGETED_PROFILES = "targeted_profiles"

export function resolveProfileImpact(input) {
	if (!isRecord(input) || !Array.isArray(input.changedPaths) || !Array.isArray(input.profiles)) {
		throw new Error("Profile impact input requires changedPaths and profiles arrays.")
	}
	const changedPaths = sortedUniqueStrings(input.changedPaths, "Changed paths must be non-empty strings.")
	for (const changedPath of changedPaths) validateRepoRelativePath(changedPath, "Changed path")
	const profiles = input.profiles.map(profile => normalizeProfile(profile))
	const matchedProfileIds = new Set()
	const uncoveredPaths = []

	for (const changedPath of changedPaths) {
		let covered = false
		for (const profile of profiles) {
			if (!profile.paths.some(rule => matchesRule(changedPath, rule))) continue
			covered = true
			matchedProfileIds.add(profile.id)
		}
		if (!covered) uncoveredPaths.push(changedPath)
	}

	if (uncoveredPaths.length > 0) {
		return {
			decision: FULL_PROFILE_REQUIRED,
			profileIds: [],
			uncoveredPaths,
		}
	}
	return {
		decision: TARGETED_PROFILES,
		profileIds: [...matchedProfileIds].sort(),
		uncoveredPaths: [],
	}
}

export function resolveProfileImpactDetailed(input) {
	if (!isRecord(input) || !Array.isArray(input.changedPaths) || !Array.isArray(input.profiles)) {
		throw new Error("Detailed profile impact input requires changedPaths and profiles arrays.")
	}
	const changedPaths = sortedUniqueStrings(input.changedPaths, "Changed paths must be non-empty strings.")
	for (const changedPath of changedPaths) validateRepoRelativePath(changedPath, "Changed path")
	const profiles = input.profiles.map(profile => normalizeDetailedProfile(profile))
	const profileById = new Map()
	for (const profile of profiles) {
		if (profileById.has(profile.id)) throw new Error(`Detailed profile ids must be unique: ${profile.id}`)
		profileById.set(profile.id, profile)
	}

	const directProfileIds = new Set()
	const supportingProfileIds = new Set()
	const uncoveredPaths = []
	const warnings = []
	const specificityByProfileId = new Map()
	for (const changedPath of changedPaths) {
		const directMatches = []
		const supportingMatches = []
		for (const profile of profiles) {
			const specificity = Math.max(
				-1,
				...profile.paths
					.filter(rule => matchesRule(changedPath, rule))
					.map(rule => rule.endsWith("/**") ? rule.length - 3 : rule.length + 1_000_000),
			)
			if (specificity < 0) continue
			if (profile.role === "supporting") supportingMatches.push(profile)
			else directMatches.push(profile)
			const prior = specificityByProfileId.get(profile.id) ?? -1
			if (specificity > prior) specificityByProfileId.set(profile.id, specificity)
		}
		for (const profile of supportingMatches) supportingProfileIds.add(profile.id)
		if (directMatches.length === 0) {
			uncoveredPaths.push(changedPath)
			if (supportingMatches.length > 0) warnings.push(`supporting_only_match:${changedPath}`)
			continue
		}
		for (const profile of directMatches) directProfileIds.add(profile.id)
	}

	const transitiveProfileIds = new Set()
	const queue = [...directProfileIds].sort()
	while (queue.length > 0) {
		const profileId = queue.shift()
		const profile = profileById.get(profileId)
		for (const requiredId of profile.requiresProfileIds) {
			if (!profileById.has(requiredId)) throw new Error(`Required profile does not exist: ${requiredId}`)
			if (directProfileIds.has(requiredId) || transitiveProfileIds.has(requiredId)) continue
			transitiveProfileIds.add(requiredId)
			queue.push(requiredId)
			queue.sort()
		}
	}

	const direct = [...directProfileIds].sort()
	if (direct.length > 10) warnings.push(`broad_profile_match:${direct.length}`)
	const flaggedPrimaryIds = direct.filter(profileId => profileById.get(profileId).primary)
	let primaryProfileId = null
	if (flaggedPrimaryIds.length === 1) primaryProfileId = flaggedPrimaryIds[0]
	else if (flaggedPrimaryIds.length > 1) warnings.push(`ambiguous_primary_profile:${flaggedPrimaryIds.join(",")}`)
	else if (direct.length === 1) primaryProfileId = direct[0]
	else if (direct.length > 1) {
		const highestSpecificity = Math.max(...direct.map(profileId => specificityByProfileId.get(profileId) ?? -1))
		const mostSpecific = direct.filter(profileId => specificityByProfileId.get(profileId) === highestSpecificity)
		if (mostSpecific.length === 1) primaryProfileId = mostSpecific[0]
		else warnings.push(`ambiguous_primary_profile:${mostSpecific.join(",")}`)
	}

	const selectedProfileIds = [...new Set([...directProfileIds, ...transitiveProfileIds])].sort()
	return {
		decision: uncoveredPaths.length > 0 ? FULL_PROFILE_REQUIRED : TARGETED_PROFILES,
		primaryProfileId,
		directProfileIds: direct,
		transitiveProfileIds: [...transitiveProfileIds].sort(),
		supportingProfileIds: [...supportingProfileIds].sort(),
		selectedProfileIds,
		uncoveredPaths: uncoveredPaths.sort(),
		warnings: [...new Set(warnings)].sort(),
	}
}

export function resolveProfileImpactProjection({ changedPaths, profiles, detailed = false }) {
	if (!detailed) return resolveProfileImpact({ changedPaths, profiles })
	const impact = resolveProfileImpactDetailed({ changedPaths, profiles })
	return {
		decision: impact.decision,
		profileIds: impact.selectedProfileIds,
		uncoveredPaths: impact.uncoveredPaths,
		directProfileIds: impact.directProfileIds,
		transitiveProfileIds: impact.transitiveProfileIds,
	}
}

function normalizeProfile(value) {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || !Array.isArray(value.paths)) {
		throw new Error("Each profile requires a non-empty id and paths array.")
	}
	const paths = sortedUniqueStrings(value.paths, "Profile paths must be non-empty strings.")
	for (const rule of paths) validateRule(rule)
	return { id: value.id, paths }
}

function normalizeDetailedProfile(value) {
	const normalized = normalizeProfile(value)
	const role = value.role ?? "primary"
	if (!new Set(["primary", "supporting"]).has(role)) {
		throw new Error("Detailed profile role must be primary or supporting.")
	}
	if (value.primary !== undefined && typeof value.primary !== "boolean") {
		throw new Error("Detailed profile primary must be a boolean.")
	}
	const requiresProfileIds = value.requiresProfileIds === undefined
		? []
		: sortedUniqueStrings(value.requiresProfileIds, "requiresProfileIds must contain non-empty strings.")
	return {
		...normalized,
		role,
		primary: value.primary ?? false,
		requiresProfileIds,
	}
}

function validateRule(rule) {
	const wildcardIndex = rule.indexOf("*")
	if (wildcardIndex === -1) {
		validateRepoRelativePath(rule, "Profile exact path rule")
		return
	}
	if (!rule.endsWith("/**") || rule.slice(0, -3).includes("*")) {
		throw new Error("Profile path rules support only exact paths and directory/**.")
	}
	validateRepoRelativePath(rule.slice(0, -3), "Profile directory rule prefix")
}

function validateRepoRelativePath(value, label) {
	if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")) {
		throw new Error(`${label} must be a safe repository-relative path.`)
	}
	const segments = value.split("/")
	if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error(`${label} must not contain empty, dot, or parent segments.`)
	}
	if (value.includes("*")) {
		throw new Error(`${label} must not contain wildcard segments.`)
	}
	if (isReservedRuntimePath(value)) {
		throw new Error(`${label} uses the reserved runtime path .owlcoda/runkit.`)
	}
}

function matchesRule(changedPath, rule) {
	if (!rule.endsWith("/**")) return changedPath === rule
	return changedPath.startsWith(`${rule.slice(0, -3)}/`)
}

function sortedUniqueStrings(values, message) {
	if (values.some(value => typeof value !== "string" || value.length === 0)) throw new Error(message)
	return [...new Set(values)].sort()
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function runCli() {
	try {
		let raw = ""
		for await (const chunk of process.stdin) raw += chunk
		const result = resolveProfileImpact(JSON.parse(raw))
		process.stdout.write(`${JSON.stringify(result)}\n`)
	} catch (error) {
		process.stdout.write(`${JSON.stringify({
			decision: "invalid_input",
			error: error instanceof Error ? error.message : String(error),
		})}\n`)
		process.exitCode = 3
	}
}

if (isDirectExecution(import.meta.url)) await runCli()
