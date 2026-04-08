export function fmtTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s ? `${m}m ${s}s` : `${m}m`;
}

export function fmtDate(iso: string): string {
	const d = new Date(iso);
	return (
		d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
		" " +
		d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	);
}

export function escapeHtml(s: string): string {
	return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
