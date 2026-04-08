import { useLocalStorage } from "@/hooks/useLocalStorage.ts";
import { WHISPER_LANGUAGES } from "@/lib/languages.ts";
import styles from "./LanguageSelect.module.css";

interface Props {
	value?: string;
	onChange?: (value: string) => void;
}

export function LanguageSelect({ value, onChange }: Props) {
	const [stored, setStored] = useLocalStorage<string>("heed-language", "es");
	const current = value ?? stored;

	const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const v = e.target.value;
		setStored(v);
		onChange?.(v);
	};

	return (
		<select className={styles.select} value={current} onChange={handleChange}>
			{WHISPER_LANGUAGES.map(([code, name]) => (
				<option key={code} value={code}>
					{name}
				</option>
			))}
		</select>
	);
}
