#!/usr/bin/env node

/**
 * create-heed CLI
 *
 * Interactive installer + updater for heed.
 *
 * Usage:
 *   npx create-heed           # install heed (first time)
 *   npx create-heed update    # pull latest changes (from anywhere)
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

// Trigger the macOS Screen-Recording permission dialog by briefly running heed-syscap
// (the binary the grant must bind to). Resolves true if it reported {"ready":true} —
// i.e. capture started, so permission is already granted. Resolves false if it errored
// out quickly (dialog shown / declined) or never reported ready within the window.
function warmSystemAudioPermission(bin) {
	return new Promise((resolve) => {
		let stderr = "";
		let settled = false;
		const finish = (granted) => {
			if (settled) return;
			settled = true;
			try { child.kill(); } catch {}
			resolve(granted);
		};
		const isReady = () => stderr.split("\n").some((l) => {
			try { return JSON.parse(l).ready === true; } catch { return false; }
		});
		const child = spawn(bin, [], { stdio: ["ignore", "ignore", "pipe"] });
		child.stderr.on("data", (d) => {
			stderr += d.toString();
			if (isReady()) finish(true);
		});
		child.on("error", () => finish(false));
		child.on("exit", () => finish(isReady())); // exited fast → likely permission error
		setTimeout(() => finish(isReady()), 3000); // still running w/o "ready" → treat as not granted
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

	const IS_APPLE_SILICON = IS_MAC && process.arch === "arm64";
	const TOTAL = IS_APPLE_SILICON ? 9 : 7;
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

	// --- Step 3: ffmpeg ---
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

	// --- Step 4: Ollama (local notes engine) ---
	step(++stepN, TOTAL, "Ollama (local AI engine)");
	if (hasCommand("ollama")) {
		const ollamaVer = cmd("ollama --version");
		ok(`Ollama ${ollamaVer || ""} already installed`);
	} else {
		warn("Ollama runs AI models locally for generating meeting notes.");
		if (await ask("Install Ollama?")) {
			if (IS_MAC) {
				// macOS: the official app bundles the llama-server runner. The Homebrew
				// *formula* (`brew install ollama`) ships WITHOUT that runner and cannot
				// generate — so we install the cask (Ollama.app) instead.
				if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
				run("brew install --cask ollama-app", "Ollama installed");
			} else {
				// Linux: official install script (ships the runner correctly).
				run("curl -fsSL https://ollama.com/install.sh | sh", "Ollama installed");
			}
		}
	}

	// --- Step 5: Download heed --- (must happen BEFORE the Python venv so we have
	// requirements.txt and a folder for .venv)
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
	info("Installing JavaScript dependencies...");
	run(`cd "${targetDir}" && bun install`, "Dependencies installed");

	// --- Step 6: Python AI packages (isolated in a project-local .venv) ---
	step(++stepN, TOTAL, "AI models (faster-whisper + pyannote + torch)");
	// torch needs Python 3.10–3.12; a system python3 can be too new (e.g. 3.14 has no
	// torch wheels yet). Prefer an explicit 3.12/3.11/3.10, and on macOS install
	// python@3.12 if none is present. We ALWAYS install into `<heed>/.venv` so the
	// system Python stays untouched and `bun run dev` (dev:python → .venv/bin/python3)
	// works identically on macOS and Linux.
	let venvPy = hasCommand("python3.12") ? "python3.12"
		: hasCommand("python3.11") ? "python3.11"
		: hasCommand("python3.10") ? "python3.10"
		: null;
	if (!venvPy) {
		if (IS_MAC) {
			if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
			run("brew install python@3.12", "Python 3.12 installed");
			venvPy = hasCommand("python3.12") ? "python3.12" : (pyCmd || "python3");
		} else {
			venvPy = pyCmd || "python3";
		}
	}
	const venvDir = join(targetDir, ".venv");
	const venvPython = join(venvDir, "bin", "python3");
	if (!existsSync(venvDir)) {
		run(`${venvPy} -m venv "${venvDir}"`, "Virtualenv created (.venv)");
	}
	const reqPath = join(targetDir, "packages", "transcription", "requirements.txt");
	const hasFW = cmd(`"${venvPython}" -c "import faster_whisper; print('ok')" 2>/dev/null`) === "ok";
	if (hasFW) {
		ok("AI packages already installed in .venv");
	} else {
		warn("Installing AI packages (~3GB download first time). This powers the transcription.");
		if (await ask("Install faster-whisper + pyannote + torch into .venv?")) {
			run(`"${venvPython}" -m pip install --upgrade pip`, "pip upgraded");
			run(`"${venvPython}" -m pip install -r "${reqPath}"`, "AI packages installed");
		}
	}

	// --- Step 7 (Apple Silicon only): Parakeet speed engine ---
	// Builds the Swift sidecar that runs Parakeet ASR + FluidAudio diarization on the Apple
	// Neural Engine — the fastest path on Mac AND the one that needs NO gated pyannote token.
	// GRACEFUL: if the Swift toolchain isn't present we skip and heed falls back to MLX-Whisper
	// (still GPU-accelerated) + pyannote. heed must never hard-fail at install.
	if (IS_APPLE_SILICON) {
		step(++stepN, TOTAL, "Parakeet speed engine (Apple Neural Engine)");
		const sidecarDir = join(targetDir, "packages", "transcription", "native", "heed-parakeet");
		const sidecarBin = join(sidecarDir, ".build", "release", "heed-parakeet");
		if (existsSync(sidecarBin)) {
			ok("Parakeet sidecar already built");
		} else if (!hasCommand("swift")) {
			info("Swift toolchain not found — skipping Parakeet (heed will use MLX-Whisper).");
			info(`Install Xcode Command Line Tools (${C.cyan}xcode-select --install${C.reset}) then re-run to enable the fastest engine.`);
		} else if (existsSync(sidecarDir)) {
			info("Building Parakeet sidecar (first build downloads CoreML deps, ~1-2 min)...");
			if (!run(`cd "${sidecarDir}" && swift build -c release`, "Parakeet sidecar built (Apple Neural Engine)")) {
				info("Parakeet build failed — heed will use MLX-Whisper instead (still fast). Continuing.");
			}
		}

		// --- Step 8 (Apple Silicon): System-audio permission (pre-armed, one time) ---
		// macOS protects system audio: capturing it ALWAYS needs the user's Screen Recording
		// permission (true of every method — SCK, Core Audio taps, etc.; only BlackHole avoids
		// it, at the cost of a sudo driver + manual output re-routing). We ask for it HERE, once,
		// at peak setup-intent, so pressing "record" later is friction-free. The dialog must be
		// triggered by heed-syscap itself (TCC binds the grant to the calling binary), so we run
		// the real binary briefly. If the toolchain was missing, this step is a no-op (mic still
		// works; system falls back to BlackHole if present).
		step(++stepN, TOTAL, "System audio permission (one-time)");
		const syscapBin = join(sidecarDir, ".build", "release", "heed-syscap");
		if (!existsSync(syscapBin)) {
			info("System-audio helper not built — heed will record mic (and BlackHole system audio if present).");
		} else {
			info("heed needs permission to capture your meetings' system audio.");
			info("A macOS dialog will appear — approve it. (Mic-only recording works without this.)");
			const granted = await warmSystemAudioPermission(syscapBin);
			if (granted) {
				ok("System audio permission granted — press record and you're done");
			} else {
				// Open the exact Settings pane so the user can flip the toggle in one move.
				try { execSync(`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`, { stdio: "ignore" }); } catch {}
				info("Enable heed (heed-syscap) under Screen Recording, then heed uses it automatically.");
				info("Until then heed records your mic; system audio falls back to BlackHole if installed.");
			}
		}
	}

	// --- Step 9: Launch ---
	step(++stepN, TOTAL, "Launch heed");
	log("");
	log(`${C.bold}${C.green}  All set!${C.reset}`);
	log("");

	const useDesktop = await ask("Open as floating desktop panel? (recommended)");

	if (useDesktop) {
		log(`  ${C.dim}Starting services + floating panel...${C.reset}`);
		log("");

		// Start dev server in background
		const devChild = spawn("bun", ["run", "dev"], {
			cwd: targetDir,
			stdio: "ignore",
			shell: true,
			detached: true,
		});
		devChild.unref();

		// Wait a bit for services to start
		info("Starting services...");
		await new Promise(r => setTimeout(r, 8000));

		// Launch desktop panel
		const panelChild = spawn("python3", ["packages/desktop/main.py"], {
			cwd: targetDir,
			stdio: "inherit",
			shell: true,
		});

		panelChild.on("exit", (code) => {
			if (code !== 0) err(`Desktop panel exited with code ${code}`);
			process.exit(0);
		});

		process.on("SIGINT", () => {
			panelChild.kill("SIGINT");
			process.exit(0);
		});
	} else {
		log(`  ${C.dim}Starting heed...${C.reset}`);
		log(`  ${C.dim}Open ${C.cyan}http://localhost:5000${C.dim} in your browser${C.reset}`);
		log("");

		const child = spawn("bun", ["run", "dev"], {
			cwd: targetDir,
			stdio: "inherit",
			shell: true,
		});

		child.on("exit", (code) => {
			if (code !== 0) err(`heed exited with code ${code}`);
		});

		process.on("SIGINT", () => {
			child.kill("SIGINT");
			process.exit(0);
		});
	}
}

// --- Update subcommand ---
async function update() {
	log("");
	log(`${C.bold}  heed update${C.reset}`);
	log("");

	// Find heed installation
	const candidates = [
		join(process.cwd(), "heed"),
		process.cwd(), // maybe already inside heed dir
		join(homedir(), "heed"),
		join(homedir(), "Desktop", "heed"),
		join(homedir(), "Projects", "heed"),
	];

	let heedDir = null;
	for (const dir of candidates) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages", "server"))) {
			heedDir = dir;
			break;
		}
	}

	if (!heedDir) {
		err("heed installation not found.");
		info("Run `npx create-heed` first to install.");
		process.exit(1);
	}

	info(`Found heed at ${C.dim}${heedDir}${C.reset}`);

	const currentHash = cmd(`cd "${heedDir}" && git rev-parse --short HEAD`);
	info(`Current: ${C.dim}${currentHash}${C.reset}`);

	info("Checking for updates...");
	if (!cmd(`cd "${heedDir}" && git fetch origin main 2>&1`)) {
		// Try without auth (public repo)
		if (!cmd(`cd "${heedDir}" && git fetch origin 2>&1`)) {
			err("Failed to fetch. Check your internet connection.");
			process.exit(1);
		}
	}

	const behind = cmd(`cd "${heedDir}" && git rev-list --count HEAD..origin/main`) || "0";
	if (behind === "0") {
		ok("Already up to date!");
		process.exit(0);
	}

	info(`${C.bold}${behind}${C.reset} new commit(s) available`);

	// Show changelog
	const changelog = cmd(`cd "${heedDir}" && git log --oneline HEAD..origin/main`);
	if (changelog) {
		log("");
		changelog.split("\n").forEach((line) => {
			log(`  ${C.dim}${line}${C.reset}`);
		});
		log("");
	}

	// Pull
	info("Downloading updates...");
	if (!cmd(`cd "${heedDir}" && git pull origin main`)) {
		err("Pull failed. You may have local changes.");
		warn(`Run: cd "${heedDir}" && git stash && npx create-heed update && git stash pop`);
		process.exit(1);
	}

	// Check what changed
	const diffFiles = cmd(`cd "${heedDir}" && git diff --name-only HEAD~${behind} HEAD`) || "";

	if (diffFiles.includes("package.json") || diffFiles.includes("bun.lock")) {
		info("Dependencies changed, installing...");
		run(`cd "${heedDir}" && bun install`, "Dependencies updated");
	}

	if (diffFiles.includes("packages/client/")) {
		info("Frontend changed, rebuilding...");
		run(`cd "${heedDir}" && bun run build`, "Frontend rebuilt");
	}

	if (diffFiles.includes("requirements.txt")) {
		const venvPy = join(heedDir, ".venv", "bin", "python3");
		if (existsSync(venvPy)) {
			info("Python dependencies changed, updating .venv...");
			run(`"${venvPy}" -m pip install -r "${heedDir}/packages/transcription/requirements.txt"`, "Python deps updated");
		} else {
			warn("Python dependencies may have changed. Run:");
			log(`  ${C.dim}${heedDir}/.venv/bin/python3 -m pip install -r ${heedDir}/packages/transcription/requirements.txt${C.reset}`);
		}
	}

	const newHash = cmd(`cd "${heedDir}" && git rev-parse --short HEAD`);
	log("");
	ok(`Updated! ${C.dim}${currentHash}${C.reset} → ${C.bold}${newHash}${C.reset} (${behind} commits)`);
	log(`  ${C.dim}Restart heed to apply: ${C.reset}${C.bold}cd "${heedDir}" && bun run dev${C.reset}`);
	log("");
}

// --- Route subcommand ---
const subcommand = process.argv[2];
if (subcommand === "update") {
	update().catch((e) => { err(e.message); process.exit(1); });
} else {
	main().catch((e) => {
		err(e.message);
		process.exit(1);
	});
}
