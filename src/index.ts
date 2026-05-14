import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL_DIR = join(homedir(), ".local", "share", "pi-camofox", "app");
const CACHE_DIR = join(homedir(), ".cache", "pi-camofox");
const TRACE_CACHE_DIR = join(CACHE_DIR, "traces");
const PID_PATH = join(CACHE_DIR, "server.pid");
const LOG_PATH = join(CACHE_DIR, "server.log");
const DEFAULT_PORT = 9377;
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const PACKAGE_NAME = "@askjo/camofox-browser";
const EXPORTED_ENV = { ...process.env };
const ENV_FILE_CANDIDATES = [
	join(homedir(), ".env"),
	join(homedir(), ".env.local"),
	join(EXTENSION_DIR, ".env"),
	join(EXTENSION_DIR, ".env.local"),
	join(process.cwd(), ".env"),
	join(process.cwd(), ".env.local"),
];
const MANAGED_ENV_KEYS = [
	"CAMOFOX_BASE_URL",
	"CAMOFOX_PROXY_URL",
	"CAMOFOX_PROXY_BYPASS",
	"CAMOFOX_CRASH_REPORT_ENABLED",
	"CAMOFOX_CRASH_REPORT_URL",
	"CAMOFOX_CRASH_REPORT_REPO",
	"CAMOFOX_CRASH_REPORT_RATE_LIMIT",
] as const;

let serverOwnedBySession = false;
let installSourcePreference: "local" | "global" = "local";
let globalPackagePath = "";
let startupPackagePromptShown = false;

function parseDotEnv(content: string) {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const exportLine = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = exportLine.indexOf("=");
		if (eq <= 0) continue;
		const key = exportLine.slice(0, eq).trim();
		let value = exportLine.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

function resolveEnv() {
	const resolved: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>> = {};
	for (const path of ENV_FILE_CANDIDATES) {
		if (!existsSync(path)) continue;
		const values = parseDotEnv(readFileSync(path, "utf8"));
		for (const key of MANAGED_ENV_KEYS) {
			const value = values[key];
			if (typeof value === "string") resolved[key] = value;
		}
	}
	for (const key of MANAGED_ENV_KEYS) {
		const value = EXPORTED_ENV[key];
		if (typeof value === "string") resolved[key] = value;
	}
	return resolved;
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getBaseUrl() {
	return resolveEnv().CAMOFOX_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function getLocalPort() {
	const baseUrl = new URL(getBaseUrl());
	if (!["127.0.0.1", "localhost"].includes(baseUrl.hostname)) return DEFAULT_PORT;
	return Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80));
}

function getLocalServerScript() {
	return join(INSTALL_DIR, "node_modules", "@askjo", "camofox-browser", "server.js");
}

function getSelectedServerScript() {
	return installSourcePreference === "global" && globalPackagePath
		? join(globalPackagePath, "server.js")
		: getLocalServerScript();
}

function compareVersions(a: string, b: string) {
	const aParts = a.split(".").map((part) => Number(part) || 0);
	const bParts = b.split(".").map((part) => Number(part) || 0);
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

async function getLocalPackageInfo() {
	const packageJsonPath = join(INSTALL_DIR, "node_modules", "@askjo", "camofox-browser", "package.json");
	try {
		const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
		return {
			installed: true,
			version: pkg.version || "unknown",
			packagePath: dirname(packageJsonPath),
			serverScript: getLocalServerScript(),
		};
	} catch {
		return { installed: false, version: undefined, packagePath: undefined, serverScript: getLocalServerScript() };
	}
}

async function getGlobalPackageInfo(pi: ExtensionAPI, signal?: AbortSignal) {
	const result = await pi.exec("bash", ["-lc", `pnpm list -g ${PACKAGE_NAME} --json`], { signal, timeout: 15000 });
	if (result.code !== 0 || !result.stdout.trim()) {
		return { installed: false, version: undefined, packagePath: undefined, serverScript: undefined };
	}
	try {
		const parsed = JSON.parse(result.stdout) as Array<{
			dependencies?: Record<string, { version?: string; path?: string }>;
		}>;
		const info = parsed[0]?.dependencies?.[PACKAGE_NAME];
		if (!info?.path) return { installed: false, version: undefined, packagePath: undefined, serverScript: undefined };
		return {
			installed: true,
			version: info.version || "unknown",
			packagePath: info.path,
			serverScript: join(info.path, "server.js"),
		};
	} catch {
		return { installed: false, version: undefined, packagePath: undefined, serverScript: undefined };
	}
}

async function getLatestPackageVersion(pi: ExtensionAPI, signal?: AbortSignal) {
	const result = await pi.exec("bash", ["-lc", `npm view ${PACKAGE_NAME} version`], { signal, timeout: 15000 });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function getPackageState(pi: ExtensionAPI, signal?: AbortSignal) {
	const [local, global] = await Promise.all([getLocalPackageInfo(), getGlobalPackageInfo(pi, signal)]);
	const latest = await getLatestPackageVersion(pi, signal);
	if (global.packagePath) globalPackagePath = global.packagePath;
	return { local, global, latest };
}

function getProxyUrl() {
	return resolveEnv().CAMOFOX_PROXY_URL?.trim() || "";
}

function getProxyBypass() {
	return resolveEnv().CAMOFOX_PROXY_BYPASS?.trim() || "";
}

function getProxyConfig() {
	const raw = getProxyUrl();
	if (!raw) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Invalid CAMOFOX_PROXY_URL. Expected a full URL such as http://user:pass@host:port");
	}
	return {
		raw,
		host: parsed.hostname,
		port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
		username: decodeURIComponent(parsed.username || ""),
		password: decodeURIComponent(parsed.password || ""),
		bypass: getProxyBypass(),
		masked: `${parsed.protocol}//${parsed.username ? "***:***@" : ""}${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`,
	};
}

function getTelemetryConfig() {
	const env = resolveEnv();
	return {
		enabled: env.CAMOFOX_CRASH_REPORT_ENABLED !== "false",
		url: env.CAMOFOX_CRASH_REPORT_URL?.trim() || "https://camofox-telemetry.askjo.workers.dev/report",
		repo: env.CAMOFOX_CRASH_REPORT_REPO?.trim() || "jo-inc/camofox-browser",
		rateLimitPerHour: Number(env.CAMOFOX_CRASH_REPORT_RATE_LIMIT?.trim() || "10"),
	};
}

async function getRecentLogs(limit = 50) {
	try {
		const raw = await readFile(LOG_PATH, "utf8");
		const lines = raw.trim().split(/\r?\n/).filter(Boolean);
		const recent = lines.slice(-Math.max(1, limit));
		const entries = recent.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return { level: "raw", msg: line };
			}
		});
		return {
			available: true,
			entries,
			text: recent.join("\n"),
			errorCount: entries.filter((entry) => entry.level === "error").length,
			warnCount: entries.filter((entry) => entry.level === "warn").length,
		};
	} catch {
		return {
			available: false,
			entries: [] as Record<string, unknown>[],
			text: "",
			errorCount: 0,
			warnCount: 0,
		};
	}
}

function requireTarget(params: { ref?: string; selector?: string }) {
	if (!params.ref && !params.selector) {
		throw new Error("Expected either ref or selector");
	}
}

function requireNavigateTarget(params: { url?: string; macro?: string }) {
	if (!params.url && !params.macro) {
		throw new Error("Expected either url or macro");
	}
}

function withDefaultTrace<T extends { trace?: boolean }>(params: T): T & { trace: boolean } {
	return {
		...params,
		trace: params.trace ?? true,
	};
}

async function isInstalled(pi: ExtensionAPI, signal?: AbortSignal) {
	const state = await getPackageState(pi, signal);
	const selected = installSourcePreference === "global" ? state.global : state.local;
	return !!selected.installed;
}

async function hasYtDlp(pi: ExtensionAPI, signal?: AbortSignal) {
	const result = await pi.exec("bash", ["-lc", "command -v yt-dlp >/dev/null 2>&1"], { signal, timeout: 5000 });
	return result.code === 0;
}

async function installCamofox(pi: ExtensionAPI, signal?: AbortSignal, force = false) {
	await mkdir(INSTALL_DIR, { recursive: true });
	const installArgs = ["npm", "install", `${PACKAGE_NAME}@latest`, "--no-fund", "--no-audit"];
	if (force) installArgs.push("--force");
	const script = [
		"set -euo pipefail",
		`cd ${JSON.stringify(INSTALL_DIR)}`,
		`[ -f package.json ] || printf '%s\n' '{"name":"pi-camofox-runtime","private":true}' > package.json`,
		installArgs.join(" "),
		"python3 -m pip install --user --break-system-packages yt-dlp",
	].join("\n");
	const result = await pi.exec("bash", ["-lc", script], { signal, timeout: 1800_000 });
	if (result.code !== 0) throw new Error((result.stderr || result.stdout || "camofox install failed").trim());
	installSourcePreference = "local";
	return { installDir: INSTALL_DIR, serverScript: getLocalServerScript(), baseUrl: getBaseUrl(), ytDlpInstalled: await hasYtDlp(pi, signal) };
}

async function getServerStatus(pi: ExtensionAPI, signal?: AbortSignal) {
	const proxy = getProxyConfig();
	const telemetry = getTelemetryConfig();
	const logs = await getRecentLogs(25);
	const packages = await getPackageState(pi, signal);
	const selectedPackage = installSourcePreference === "global" ? packages.global : packages.local;
	let pid: number | undefined;
	try {
		pid = Number((await readFile(PID_PATH, "utf8")).trim());
	} catch {}
	let running = false;
	if (pid) {
		const probe = await pi.exec("bash", ["-lc", `kill -0 ${pid}`], { signal, timeout: 5000 });
		running = probe.code === 0;
		if (!running) {
			try { await unlink(PID_PATH); } catch {}
		}
	}
	return {
		installed: !!selectedPackage.installed,
		ytDlpInstalled: await hasYtDlp(pi, signal),
		running,
		pid,
		baseUrl: getBaseUrl(),
		logPath: LOG_PATH,
		installDir: INSTALL_DIR,
		proxyEnabled: !!proxy,
		proxy: proxy?.masked,
		telemetry,
		packageSource: installSourcePreference,
		packageVersions: {
			latest: packages.latest,
			local: packages.local.version,
			global: packages.global.version,
		},
		logs: {
			available: logs.available,
			errorCount: logs.errorCount,
			warnCount: logs.warnCount,
			lastMessages: logs.entries.slice(-5).map((entry) => {
				const level = typeof entry.level === "string" ? entry.level : "info";
				const msg = typeof entry.msg === "string" ? entry.msg : JSON.stringify(entry);
				return `${level}: ${msg}`;
			}),
		},
	};
}

async function startServer(pi: ExtensionAPI, signal?: AbortSignal) {
	const packages = await getPackageState(pi, signal);
	if (installSourcePreference === "global" && !packages.global.installed) {
		installSourcePreference = "local";
	}
	if (installSourcePreference === "local" && !packages.local.installed) {
		if (packages.global.installed) {
			installSourcePreference = "global";
		} else {
			await installCamofox(pi, signal);
		}
	}
	const status = await getServerStatus(pi, signal);
	if (status.running) return { started: false, ...status };
	await mkdir(CACHE_DIR, { recursive: true });
	const proxy = getProxyConfig();
	const envParts = [`CAMOFOX_PORT=${getLocalPort()}`];
	if (proxy) {
		envParts.push(`PROXY_HOST=${shellQuote(proxy.host)}`);
		envParts.push(`PROXY_PORT=${shellQuote(proxy.port)}`);
		if (proxy.username) envParts.push(`PROXY_USERNAME=${shellQuote(proxy.username)}`);
		if (proxy.password) envParts.push(`PROXY_PASSWORD=${shellQuote(proxy.password)}`);
		if (proxy.bypass) envParts.push(`NO_PROXY=${shellQuote(proxy.bypass)}`);
	}
	const selectedScript = getSelectedServerScript();
	const selectedDir = dirname(selectedScript);
	const script = [
		"set -euo pipefail",
		`mkdir -p ${JSON.stringify(CACHE_DIR)}`,
		`cd ${JSON.stringify(selectedDir)}`,
		`nohup env ${envParts.join(" ")} node ${JSON.stringify(selectedScript)} >> ${JSON.stringify(LOG_PATH)} 2>&1 & echo $! > ${JSON.stringify(PID_PATH)}`,
		"sleep 3",
		`pid=$(cat ${JSON.stringify(PID_PATH)})`,
		`kill -0 "$pid"`,
	].join("\n");
	const result = await pi.exec("bash", ["-lc", script], { signal, timeout: 20000 });
	if (result.code !== 0) throw new Error((result.stderr || result.stdout || "camofox start failed").trim());
	return { started: true, ...(await getServerStatus(pi, signal)) };
}

async function stopServer(pi: ExtensionAPI, signal?: AbortSignal) {
	const status = await getServerStatus(pi, signal);
	if (!status.running || !status.pid) return { stopped: false, ...status };
	const script = [
		"set -euo pipefail",
		`pid=${status.pid}`,
		`kill "$pid" || true`,
		"sleep 1",
		`kill -0 "$pid" 2>/dev/null && kill -9 "$pid" || true`,
		`rm -f ${JSON.stringify(PID_PATH)}`,
	].join("\n");
	const result = await pi.exec("bash", ["-lc", script], { signal, timeout: 15000 });
	if (result.code !== 0) throw new Error((result.stderr || result.stdout || "camofox stop failed").trim());
	return { stopped: true, ...(await getServerStatus(pi, signal)) };
}

async function api<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`${getBaseUrl()}${path}`, {
		...init,
		signal,
		headers: {
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`);
	return text ? JSON.parse(text) as T : ({} as T);
}

async function downloadTrace(userId: string, filename: string, outputPath?: string, signal?: AbortSignal) {
	const response = await fetch(`${getBaseUrl()}/sessions/${encodeURIComponent(userId)}/traces/${encodeURIComponent(filename)}`, { signal });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `${response.status} ${response.statusText}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	const path = outputPath || join(TRACE_CACHE_DIR, userId, filename);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, buffer);
	return { path, sizeBytes: buffer.byteLength, filename, userId };
}

async function refreshDisplay(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const status = await getServerStatus(pi, ctx.signal);
	ctx.ui.setStatus("camofox", status.running ? "Camofox running" : status.installed ? "Camofox ready" : "Camofox not installed");
	ctx.ui.setWidget("camofox-status", [
		`Camofox install: ${status.installed ? "present" : "missing"}`,
		`Package source: ${status.packageSource}`,
		`Package versions: local=${status.packageVersions.local || "missing"} global=${status.packageVersions.global || "missing"} latest=${status.packageVersions.latest || "unknown"}`,
		`yt-dlp: ${status.ytDlpInstalled ? "present" : "missing"}`,
		`Camofox server: ${status.running ? `running (pid ${status.pid})` : "stopped"}`,
		`Session ownership: ${serverOwnedBySession ? "session-owned" : "shared/external"}`,
		`Base URL: ${status.baseUrl}`,
		`Proxy: ${status.proxyEnabled ? status.proxy : "disabled"}`,
		`Telemetry: ${status.telemetry.enabled ? `enabled -> ${status.telemetry.repo}` : "disabled"}`,
		`Recent logs: ${status.logs.available ? `${status.logs.warnCount} warn / ${status.logs.errorCount} error` : "unavailable"}`,
		`Env sources: ~/.env, extension .env, cwd .env, exported env overrides`,
		`Log: ${status.logPath}`,
	]);
}

async function maybePromptForPackageChoice(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI || startupPackagePromptShown) return;
	startupPackagePromptShown = true;
	const packages = await getPackageState(pi, ctx.signal);
	const options: Array<{ label: string; action: "keep-local" | "update-local" | "use-global" }> = [];
	if (packages.global.installed) {
		options.push({
			label: `Use global ${packages.global.version} for this session`,
			action: "use-global",
		});
	}
	if (packages.local.installed && packages.latest && compareVersions(packages.local.version || "0.0.0", packages.latest) < 0) {
		options.push({
			label: `Update local ${packages.local.version} -> ${packages.latest}`,
			action: "update-local",
		});
	}
	if (packages.local.installed) {
		options.push({
			label: `Keep local ${packages.local.version}`,
			action: "keep-local",
		});
	}
	const hasActionableChoice = options.some((option) => option.action !== "keep-local");
	if (!hasActionableChoice) return;
	const selected = await ctx.ui.select("Camofox package options", options.map((option) => option.label));
	const choice = options.find((option) => option.label === selected);
	if (!choice) return;
	if (choice.action === "use-global" && packages.global.installed && packages.global.packagePath) {
		installSourcePreference = "global";
		globalPackagePath = packages.global.packagePath;
		ctx.ui.notify(`Using global ${PACKAGE_NAME} ${packages.global.version}`, "info");
	}
	if (choice.action === "update-local") {
		await installCamofox(pi, ctx.signal, true);
		installSourcePreference = "local";
		ctx.ui.notify(`Updated local ${PACKAGE_NAME} to latest`, "info");
	}
	if (choice.action === "keep-local") {
		installSourcePreference = "local";
	}
	await refreshDisplay(pi, ctx);
}

export default function camofoxExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		serverOwnedBySession = false;
		startupPackagePromptShown = false;
		await refreshDisplay(pi, ctx);
		await maybePromptForPackageChoice(pi, ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (serverOwnedBySession) {
			try {
				await stopServer(pi, ctx.signal);
			} catch {
				// Best-effort cleanup only.
			} finally {
				serverOwnedBySession = false;
			}
		}
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("camofox", undefined);
		ctx.ui.setWidget("camofox-status", undefined);
	});

	pi.registerCommand("camofox-setup", {
		description: "Install or update camofox-browser",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("camofox", "Installing Camofox...");
			try {
				const result = await installCamofox(pi, ctx.signal);
				ctx.ui.notify(`Installed ${PACKAGE_NAME} in ${result.installDir}`, "info");
			} finally {
				await refreshDisplay(pi, ctx);
			}
		},
	});

	pi.registerCommand("camofox-start", {
		description: "Start the local camofox-browser server",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("camofox", "Starting Camofox...");
			try {
				const result = await startServer(pi, ctx.signal);
				serverOwnedBySession = !!result.started;
				ctx.ui.notify(`${result.started ? "Started" : "Using existing"} Camofox at ${result.baseUrl}`, "info");
			} finally {
				await refreshDisplay(pi, ctx);
			}
		},
	});

	pi.registerCommand("camofox-stop", {
		description: "Stop the local camofox-browser server",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("camofox", "Stopping Camofox...");
			try {
				const result = await stopServer(pi, ctx.signal);
				serverOwnedBySession = false;
				ctx.ui.notify(result.stopped ? "Stopped Camofox" : "Camofox was not running", "info");
			} finally {
				await refreshDisplay(pi, ctx);
			}
		},
	});

	pi.registerCommand("camofox-status", {
		description: "Show Camofox install/server status",
		handler: async (_args, ctx) => {
			const status = await getServerStatus(pi, ctx.signal);
			await refreshDisplay(pi, ctx);
			ctx.ui.notify(JSON.stringify(status, null, 2), "info");
		},
	});

	pi.registerCommand("camofox-logs", {
		description: "Show recent structured Camofox server logs",
		handler: async (args, ctx) => {
			const limit = Math.max(1, Math.min(200, Number(args?.trim() || "50") || 50));
			const logs = await getRecentLogs(limit);
			await refreshDisplay(pi, ctx);
			ctx.ui.notify(logs.available ? logs.text || "No log lines yet" : `No log file at ${LOG_PATH}`, "info");
		},
	});

	pi.registerCommand("camofox-traces", {
		description: "List saved trace files for a user",
		handler: async (args, ctx) => {
			const userId = args?.trim();
			if (!userId) {
				ctx.ui.notify("Usage: /camofox-traces <userId>", "error");
				return;
			}
			const traces = await api(`/sessions/${encodeURIComponent(userId)}/traces`, {}, ctx.signal);
			await refreshDisplay(pi, ctx);
			ctx.ui.notify(JSON.stringify(traces, null, 2), "info");
		},
	});

	pi.registerCommand("camofox-download-trace", {
		description: "Download a saved trace zip: /camofox-download-trace <userId> <filename> [outputPath]",
		handler: async (args, ctx) => {
			const [userId, filename, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
			if (!userId || !filename) {
				ctx.ui.notify("Usage: /camofox-download-trace <userId> <filename> [outputPath]", "error");
				return;
			}
			const result = await downloadTrace(userId, filename, rest[0], ctx.signal);
			ctx.ui.notify(`Downloaded trace to ${result.path}`, "info");
		},
	});

	pi.registerCommand("camofox-delete-trace", {
		description: "Delete a saved trace zip: /camofox-delete-trace <userId> <filename>",
		handler: async (args, ctx) => {
			const [userId, filename] = (args || "").trim().split(/\s+/).filter(Boolean);
			if (!userId || !filename) {
				ctx.ui.notify("Usage: /camofox-delete-trace <userId> <filename>", "error");
				return;
			}
			const result = await api(`/sessions/${encodeURIComponent(userId)}/traces/${encodeURIComponent(filename)}`, { method: "DELETE" }, ctx.signal);
			ctx.ui.notify(JSON.stringify(result, null, 2), "info");
		},
	});

	pi.registerTool({
		name: "camofox_setup",
		label: "Camofox Setup",
		description: "Install or update the camofox-browser server package.",
		parameters: Type.Object({ force: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await installCamofox(pi, signal, params.force ?? false);
			await refreshDisplay(pi, ctx);
			return { content: [{ type: "text", text: `Installed ${PACKAGE_NAME} in ${result.installDir}` }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_start",
		label: "Camofox Start",
		description: "Start or reuse the local camofox-browser server.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const result = await startServer(pi, signal);
			serverOwnedBySession = !!result.started;
			await refreshDisplay(pi, ctx);
			return { content: [{ type: "text", text: `${result.started ? "Started" : "Using existing"} Camofox at ${result.baseUrl}` }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_stop",
		label: "Camofox Stop",
		description: "Stop the local camofox-browser server.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const result = await stopServer(pi, signal);
			serverOwnedBySession = false;
			await refreshDisplay(pi, ctx);
			return { content: [{ type: "text", text: result.stopped ? "Stopped Camofox" : "Camofox was not running" }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_status",
		label: "Camofox Status",
		description: "Show whether the local camofox-browser server is installed and running.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const result = await getServerStatus(pi, signal);
			await refreshDisplay(pi, ctx);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_logs",
		label: "Camofox Logs",
		description: "Read recent structured Camofox server logs for debugging and telemetry visibility.",
		parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
		async execute(_id, params) {
			const logs = await getRecentLogs(Math.max(1, Math.min(200, params.limit ?? 50)));
			return {
				content: [{ type: "text", text: logs.available ? logs.text || "No log lines yet" : `No log file at ${LOG_PATH}` }],
				details: logs,
			};
		},
	});

	pi.registerTool({
		name: "camofox_list_traces",
		label: "Camofox List Traces",
		description: "List saved Playwright trace files for a user.",
		parameters: Type.Object({ userId: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/sessions/${encodeURIComponent(params.userId)}/traces`, {}, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_download_trace",
		label: "Camofox Download Trace",
		description: "Download a saved Playwright trace zip to a local file path.",
		parameters: Type.Object({
			userId: Type.String(),
			filename: Type.String(),
			outputPath: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal) {
			const result = await downloadTrace(params.userId, params.filename, params.outputPath, signal);
			return { content: [{ type: "text", text: `Downloaded trace to ${result.path}` }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_delete_trace",
		label: "Camofox Delete Trace",
		description: "Delete a saved Playwright trace zip from the Camofox server.",
		parameters: Type.Object({ userId: Type.String(), filename: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/sessions/${encodeURIComponent(params.userId)}/traces/${encodeURIComponent(params.filename)}`, { method: "DELETE" }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_create_tab",
		label: "Camofox Create Tab",
		description: "Open a new browser tab at a URL using the local camofox-browser server.",
		parameters: Type.Object({
			userId: Type.String(),
			sessionKey: Type.String(),
			url: Type.String(),
			trace: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal) {
			const request = withDefaultTrace(params);
			const result = await api<{ tabId: string; url: string }>("/tabs", { method: "POST", body: JSON.stringify(request) }, signal);
			return {
				content: [{ type: "text", text: `Opened tab ${result.tabId} at ${result.url} (trace ${request.trace ? "enabled" : "disabled"})` }],
				details: { ...result, trace: request.trace },
			};
		},
	});

	pi.registerTool({
		name: "camofox_snapshot",
		label: "Camofox Snapshot",
		description: "Get an accessibility snapshot with element refs from a tab.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/snapshot?userId=${encodeURIComponent(params.userId)}`, {}, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_click",
		label: "Camofox Click",
		description: "Click an element by ref or CSS selector.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()) }),
		async execute(_id, params, signal) {
			requireTarget(params);
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/click`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_type",
		label: "Camofox Type",
		description: "Type text into an element.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.String(), pressEnter: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal) {
			requireTarget(params);
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/type`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_navigate",
		label: "Camofox Navigate",
		description: "Navigate a tab to a URL or macro.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String(), url: Type.Optional(Type.String()), macro: Type.Optional(Type.String()), query: Type.Optional(Type.String()) }),
		async execute(_id, params, signal) {
			requireNavigateTarget(params);
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/navigate`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_wait",
		label: "Camofox Wait",
		description: "Wait for the current page to settle or network to go idle.",
		parameters: Type.Object({
			tabId: Type.String(),
			userId: Type.String(),
			timeout: Type.Optional(Type.Number()),
			waitForNetwork: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/wait`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_press",
		label: "Camofox Press",
		description: "Press a keyboard key in the active tab.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String(), key: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/press`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_scroll",
		label: "Camofox Scroll",
		description: "Scroll the current page.",
		parameters: Type.Object({
			tabId: Type.String(),
			userId: Type.String(),
			direction: Type.Optional(Type.String()),
			amount: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/scroll`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_evaluate",
		label: "Camofox Evaluate",
		description: "Run a JavaScript expression in the current tab.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String(), expression: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}/evaluate`, { method: "POST", body: JSON.stringify(params) }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_close_tab",
		label: "Camofox Close Tab",
		description: "Close a browser tab.",
		parameters: Type.Object({ tabId: Type.String(), userId: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/tabs/${encodeURIComponent(params.tabId)}?userId=${encodeURIComponent(params.userId)}`, { method: "DELETE" }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "camofox_list_tabs",
		label: "Camofox List Tabs",
		description: "List open tabs for a user.",
		parameters: Type.Object({ userId: Type.String() }),
		async execute(_id, params, signal) {
			const result = await api(`/tabs?userId=${encodeURIComponent(params.userId)}`, {}, signal);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
