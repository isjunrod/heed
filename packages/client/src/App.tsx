import { useUIStore } from "@/stores/ui.ts";
import { Nav } from "@/components/layout/Nav.tsx";
import { Toast } from "@/components/layout/Toast.tsx";
import { Footer } from "@/components/layout/Footer.tsx";
import { RecordPage } from "@/components/recording/RecordPage.tsx";
import { SessionsPage } from "@/components/sessions/SessionsPage.tsx";
import { ActionsPage } from "@/components/actions/ActionsPage.tsx";
import { MeetingBanner } from "@/components/meeting-detector/MeetingBanner.tsx";
import styles from "./App.module.css";

export function App() {
	const currentPage = useUIStore((s) => s.currentPage);

	return (
		<>
			<Nav />
			<main className={styles.main}>
				{currentPage === "record" && <RecordPage />}
				{currentPage === "sessions" && <SessionsPage />}
				{currentPage === "actions" && <ActionsPage />}
			</main>
			<Footer />
			<Toast />
			<MeetingBanner />
		</>
	);
}
