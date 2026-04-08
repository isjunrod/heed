import styles from "./Footer.module.css";

export function Footer() {
	return (
		<footer className={styles.footer}>
			<div className={styles.text}>
				heed · local-first meeting notes · MIT
			</div>
		</footer>
	);
}
