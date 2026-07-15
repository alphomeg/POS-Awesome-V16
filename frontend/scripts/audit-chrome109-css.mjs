import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const COUNTER_GRID_COLOR_MIX_CLASSES = [
	"posa-cart-empty-state",
	"posa-cart-empty-state__icon-wrap",
];

export const COUNTER_GRID_SOLID_SELECTION_CLASSES = [
	"posa-cart-item-row--keyboard-active",
	"posa-cart-item-cell--keyboard-active",
];

function parseDeclarations(body) {
	return body
		.split(";")
		.map((declaration) => declaration.trim())
		.filter(Boolean)
		.map((declaration) => {
			const separator = declaration.indexOf(":");
			if (separator <= 0) return null;
			return {
				property: declaration.slice(0, separator).trim(),
				value: declaration.slice(separator + 1).trim(),
			};
		})
		.filter(Boolean);
}

const isDisabledMotion = (value) => /^none(?:\s|!|$)/i.test(value);

export function auditChrome109CounterGridCss(css, label = "Counter Grid CSS") {
	const seenClasses = new Set();
	const solidSelection = new Map(
		COUNTER_GRID_SOLID_SELECTION_CLASSES.map((className) => [
			className,
			{
				navy: false,
				cyan: false,
				noAnimation: false,
				noTransition: false,
			},
		]),
	);
	let whiteInactiveCells = false;
	const failures = [];
	const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
	let match;
	while ((match = rulePattern.exec(css))) {
		const selector = match[1];
		const body = match[2];
		const declarations = parseDeclarations(body);
		const selectionClasses = COUNTER_GRID_SOLID_SELECTION_CLASSES.filter(
			(className) => selector.includes(`.${className}`),
		);
		for (const className of selectionClasses) {
			const state = solidSelection.get(className);
			if (body.includes("color-mix(")) {
				failures.push(
					`.${className} must use a fixed Chrome 109 selection color`,
				);
			}
			for (const declaration of declarations) {
				const value = declaration.value.toLowerCase();
				if (
					declaration.property === "background" &&
					/#174a70\b/.test(value)
				)
					state.navy = true;
				if (value.includes("#38bdf8")) state.cyan = true;
				if (declaration.property === "animation") {
					if (isDisabledMotion(value)) state.noAnimation = true;
					else
						failures.push(
							`.${className} selection animation must be none`,
						);
				}
				if (declaration.property === "transition") {
					if (isDisabledMotion(value)) state.noTransition = true;
					else
						failures.push(
							`.${className} selection transition must be none`,
						);
				}
			}
		}

		const counterGridRule =
			selector.includes(".posa-cart-table--counter-grid") ||
			selector.includes(".posa-items-table-container--counter-grid");
		if (counterGridRule && /:nth-child\((?:even|2n)\)/i.test(selector)) {
			failures.push(
				`${selector.trim()} -> Counter Grid rows must not use zebra striping`,
			);
		}
		if (
			counterGridRule &&
			selector.includes("td") &&
			declarations.some(
				(declaration) =>
					declaration.property === "background" &&
					/^#(?:fff|ffffff)(?:\s|!|$)/i.test(declaration.value),
			)
		) {
			whiteInactiveCells = true;
		}

		const matchingClasses = COUNTER_GRID_COLOR_MIX_CLASSES.filter(
			(className) => selector.includes(`.${className}`),
		);
		if (!matchingClasses.length || !body.includes("color-mix(")) continue;
		matchingClasses.forEach((className) => seenClasses.add(className));

		declarations.forEach((declaration, index) => {
			if (!declaration.value.includes("color-mix(")) return;
			const hasFallback = declarations
				.slice(0, index)
				.some(
					(candidate) =>
						candidate.property === declaration.property &&
						!candidate.value.includes("color-mix("),
				);
			if (!hasFallback) {
				failures.push(
					`${selector.trim()} -> ${declaration.property} needs a preceding Chrome 109 fallback`,
				);
			}
		});
	}

	for (const className of COUNTER_GRID_COLOR_MIX_CLASSES) {
		if (!seenClasses.has(className)) {
			failures.push(`.${className} color-mix rule was not found`);
		}
	}
	for (const [className, state] of solidSelection) {
		if (!state.navy)
			failures.push(`.${className} fixed navy background was not found`);
	}
	const rowState = solidSelection.get("posa-cart-item-row--keyboard-active");
	if (!rowState?.noAnimation || !rowState?.noTransition) {
		failures.push(
			"active Counter Grid rows must disable animation and transition",
		);
	}
	const cellState = solidSelection.get(
		"posa-cart-item-cell--keyboard-active",
	);
	if (!cellState?.cyan)
		failures.push(
			"active Counter Grid cells need the fixed cyan focus ring",
		);
	if (!whiteInactiveCells)
		failures.push("white inactive Counter Grid cell styling was not found");
	if (failures.length) {
		throw new Error(
			`${label} compatibility audit failed:\n${failures.join("\n")}`,
		);
	}
	return {
		auditedClasses: [
			...seenClasses,
			...COUNTER_GRID_SOLID_SELECTION_CLASSES,
		],
		label,
	};
}

export function auditChrome109ProgressiveFallbacks(
	css,
	label = "application CSS",
) {
	const failures = [];
	const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
	let match;
	while ((match = rulePattern.exec(css))) {
		const selector = match[1].trim();
		const declarations = parseDeclarations(match[2]);
		declarations.forEach((declaration, index) => {
			const value = declaration.value.toLowerCase();
			let feature = null;
			if (value.includes("color-mix(")) feature = "color-mix";
			if (value.includes("dvh")) feature = "dvh";
			if (!feature) return;

			const hasFallback = declarations
				.slice(0, index)
				.some((candidate) => {
					if (candidate.property !== declaration.property)
						return false;
					const candidateValue = candidate.value.toLowerCase();
					return feature === "color-mix"
						? !candidateValue.includes("color-mix(")
						: candidateValue.includes("vh") &&
								!candidateValue.includes("dvh");
				});
			if (!hasFallback) {
				failures.push(
					`${selector} -> ${declaration.property} needs a preceding Chrome 109-safe ${feature} fallback`,
				);
			}
		});
	}

	if (failures.length) {
		throw new Error(
			`${label} progressive compatibility audit failed:\n${failures.join("\n")}`,
		);
	}
	return { label };
}

function walkSourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return walkSourceFiles(entryPath);
		if (entry.name.endsWith(".vue.css")) return [];
		return entry.name.endsWith(".css") || entry.name.endsWith(".vue")
			? [entryPath]
			: [];
	});
}

function extractVueCss(source) {
	const blocks = [];
	const stylePattern = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
	let styleMatch;
	while ((styleMatch = stylePattern.exec(source))) blocks.push(styleMatch[1]);

	const inlinePattern = /\bstyle="([^"]*(?:color-mix\(|dvh)[^"]*)"/gi;
	let inlineMatch;
	let inlineIndex = 0;
	while ((inlineMatch = inlinePattern.exec(source))) {
		blocks.push(`.inline-style-${inlineIndex++}{${inlineMatch[1]}}`);
	}
	return blocks.join("\n");
}

function auditSourceCss() {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const sourceDir = path.resolve(scriptDir, "../src/posapp");
	const sourceFiles = walkSourceFiles(sourceDir);
	for (const fileName of sourceFiles) {
		const source = readFileSync(fileName, "utf8");
		const css = fileName.endsWith(".vue") ? extractVueCss(source) : source;
		auditChrome109ProgressiveFallbacks(
			css,
			path.relative(sourceDir, fileName),
		);
	}
	return sourceFiles.length;
}

function auditBuiltCss() {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const outputDir = path.resolve(
		scriptDir,
		"../../posawesome/public/dist/js",
	);
	const cssFiles = readdirSync(outputDir).filter((fileName) =>
		fileName.endsWith(".css"),
	);
	if (!cssFiles.length) {
		throw new Error(`No production CSS artifacts found in ${outputDir}`);
	}
	const css = cssFiles
		.map((fileName) => readFileSync(path.join(outputDir, fileName), "utf8"))
		.join("\n");
	const result = auditChrome109CounterGridCss(css, "production CSS");
	const sourceFileCount = auditSourceCss();
	process.stdout.write(
		`Chrome 109 CSS audit passed for ${result.auditedClasses.length} Counter Grid states and ${sourceFileCount} application style sources.\n`,
	);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
	auditBuiltCss();
}
