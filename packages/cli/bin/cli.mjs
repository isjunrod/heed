#!/usr/bin/env node

/**
 * create-heed CLI
 *
 * Interactive installer for heed — local-first meeting transcription.
 * Detects OS, checks dependencies, installs what's missing, clones the
 * repo, and opens the app in the browser.
 *
 * Usage: npx create-heed
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { platform, homedir, cpus } from "node:os";

// --- Colors (ANSI) ---
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

const log = (msg) => console.log(msg);
const info = (msg) => log(`${C.blue}>${C.reset} ${msg}`);
const ok = (msg) => log(`${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => log(`${C.yellow}!${C.reset} ${msg}`);
const err = (msg) => log(`${C.red}✗${C.reset} ${msg}`);
const step = (n, total, msg) => log(`\n${C.bold}[${n}/${total}]${C.reset} ${msg}`);

// --- Utils ---
function cmd(command) {
	try {
		return execSync(command, { encoding: "utf-8", stdio: "pipe" }).trim();
	} catch {
		return null;
	}
}

function hasCommand(name) {
	return cmd(`which ${name}`) !== null;
}

async function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${C.cyan}?${C.reset} ${question} ${C.dim}(Y/n)${C.reset} `, (answer) => {
			rl.close();
			resolve(!answer || answer.toLowerCase().startsWith("y"));
		});
	});
}

function run(command, label) {
	info(`Running: ${C.dim}${command}${C.reset}`);
	try {
		execSync(command, { stdio: "inherit" });
		ok(label || "Done");
		return true;
	} catch (e) {
		err(`Failed: ${command}`);
		return false;
	}
}

// --- OS Detection ---
const OS = platform();
const IS_MAC = OS === "darwin";
const IS_LINUX = OS === "linux";

function getLinuxDistro() {
	const release = cmd("cat /etc/os-release 2>/dev/null") || "";
	const id = (release.match(/^ID=(.+)$/m)?.[1] || "").replace(/"/g, "").toLowerCase();
	const idLike = (release.match(/^ID_LIKE=(.+)$/m)?.[1] || "").replace(/"/g, "").toLowerCase();
	const all = `${id} ${idLike}`;
	if (/debian|ubuntu|mint|pop/.test(all)) return "debian";
	if (/fedora|rhel|centos/.test(all)) return "fedora";
	if (/arch|manjaro|endeavour/.test(all)) return "arch";
	return "other";
}

// --- Main ---
async function main() {
	log("");
	log(`${C.bold}  heed${C.reset} — local-first meeting transcription`);
	log(`${C.dim}  every voice, even when they speak at once.${C.reset}`);
	log(`${C.dim}  Local. Open. Yours.${C.reset}`);
	log("");

	if (!IS_MAC && !IS_LINUX) {
		err("heed currently supports Linux and macOS only.");
		err("Windows support is coming soon.");
		process.exit(1);
	}

	info(`Detected: ${C.bold}${IS_MAC ? "macOS" : "Linux"}${C.reset} (${cpus()[0]?.model || "unknown CPU"})`);
	log("");

	const TOTAL = 7;
	let stepN = 0;

	// --- Step 1: Bun ---
	step(++stepN, TOTAL, "Bun runtime");
	if (hasCommand("bun")) {
		const ver = cmd("bun --version");
		ok(`Bun ${ver} already installed`);
	} else {
		warn("Bun is not installed. It's the JavaScript runtime heed uses.");
		if (await ask("Install Bun?")) {
			run("curl -fsSL https://bun.sh/install | bash", "Bun installed");
			// Add to PATH for this session
			process.env.PATH = `${homedir()}/.bun/bin:${process.env.PATH}`;
		} else {
			err("Bun is required. Install it manually: https://bun.sh");
			process.exit(1);
		}
	}

	// --- Step 2: Python ---
	step(++stepN, TOTAL, "Python 3.10+");
	const pyCmd = hasCommand("python3") ? "python3" : hasCommand("python") ? "python" : null;
	if (pyCmd) {
		const pyVer = cmd(`${pyCmd} --version`);
		ok(`${pyVer} found`);
	} else {
		warn("Python 3.10+ is not installed.");
		if (IS_MAC) {
			if (await ask("Install Python via Homebrew?")) {
				if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
				run("brew install python@3.12", "Python installed");
			}
		} else {
			const distro = getLinuxDistro();
			const cmds = { debian: "sudo apt install -y python3 python3-pip", fedora: "sudo dnf install -y python3 python3-pip", arch: "sudo pacman -S --noconfirm python python-pip" };
			if (await ask(`Install Python? (${cmds[distro] || "manual"})`)) {
				run(cmds[distro] || cmds.debian, "Python installed");
			}
		}
	}

	// --- Step 3: Python AI packages ---
	step(++stepN, TOTAL, "AI models (faster-whisper + pyannote)");
	const hasFW = cmd(`${pyCmd || "python3"} -c "import faster_whisper" 2>&1`) !== null
		? cmd(`${pyCmd || "python3"} -c "import faster_whisper; print('ok')"`) === "ok"
		: false;
	if (hasFW) {
		ok("faster-whisper already installed");
	} else {
		warn("Installing AI packages (~3GB download first time). This powers the transcription.");
		if (await ask("Install faster-whisper + pyannote-audio + torch?")) {
			const pipCmd = IS_MAC ? "pip3 install" : "pip install --break-system-packages";
			run(`${pipCmd} faster-whisper pyannote-audio`, "AI packages installed");
		}
	}

	// --- Step 4: ffmpeg ---
	step(++stepN, TOTAL, "ffmpeg (audio capture)");
	if (hasCommand("ffmpeg")) {
		ok("ffmpeg already installed");
	} else {
		warn("ffmpeg is needed to capture and process audio.");
		if (await ask("Install ffmpeg?")) {
			if (IS_MAC) {
				run("brew install ffmpeg", "ffmpeg installed");
			} else {
				const distro = getLinuxDistro();
				const cmds = { debian: "sudo apt install -y ffmpeg", fedora: "sudo dnf install -y ffmpeg", arch: "sudo pacman -S --noconfirm ffmpeg" };
				run(cmds[distro] || cmds.debian, "ffmpeg installed");
			}
		}
	}

	// --- Step 5: Ollama ---
	step(++stepN, TOTAL, "Ollama (local AI engine)");
	if (hasCommand("ollama")) {
		const ollamaVer = cmd("ollama --version");
		ok(`Ollama ${ollamaVer || ""} already installed`);
	} else {
		warn("Ollama runs AI models locally for generating meeting notes.");
		if (await ask("Install Ollama?")) {
			run("curl -fsSL https://ollama.com/install.sh | sh", "Ollama installed");
		}
	}

	// --- Step 6: Clone heed ---
	step(++stepN, TOTAL, "Download heed");
	const targetDir = join(process.cwd(), "heed");
	if (existsSync(targetDir)) {
		ok(`heed already exists at ${targetDir}`);
		info("Pulling latest changes...");
		run(`cd "${targetDir}" && git pull`, "Updated");
	} else {
		info("Cloning from GitHub...");
		run(`git clone https://github.com/isjunrod/heed.git "${targetDir}"`, "Downloaded");
	}

	// Install dependencies
	info("Installing JavaScript dependencies...");
	run(`cd "${targetDir}" && bun install`, "Dependencies installed");

	// --- Step 7: Launch ---
	step(++stepN, TOTAL, "Launch heed");
	log("");
	log(`${C.bold}${C.green}  All set!${C.reset}`);
	log("");
	log(`  ${C.dim}Starting heed...${C.reset}`);
	log(`  ${C.dim}Open ${C.cyan}http://localhost:5000${C.dim} in your browser${C.reset}`);
	log("");

	// Start in foreground so user sees logs
	const child = spawn("bun", ["run", "dev"], {
		cwd: targetDir,
		stdio: "inherit",
		shell: true,
	});

	child.on("exit", (code) => {
		if (code !== 0) err(`heed exited with code ${code}`);
	});

	// Handle Ctrl+C gracefully
	process.on("SIGINT", () => {
		child.kill("SIGINT");
		process.exit(0);
	});
}

main().catch((e) => {
	err(e.message);
	process.exit(1);
});
