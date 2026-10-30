/**
 * dsh-claude-driver client half: cap the expanded reasoning ("思考") body at a
 * max height and keep it scrolled to the latest text while streaming, and show
 * one composer line for Claude Code sessions: session price plus the 5-hour and
 * weekly plan windows.
 *
 * The reasoning body is rendered by @deepseek-ai/dsh-client-ui-chat's
 * ReasoningRow component. Its CSS-module class is hash-prefixed per build
 * (e.g. `wM8ffq_thinkBody`), so we match on the stable `_thinkBody` suffix
 * instead of the hash. If a future ui-chat build renames the class outright,
 * this degrades to a no-op (unbounded box, today's stock behaviour) — it can
 * never break the chat view.
 *
 * Height is tunable without a rebuild via the CSS variable
 * `--claude-driver-think-max-height` (default 320px).
 */
window.__ModuleLoader__.load({
	id: "dsh-claude-driver",
	factory: (require) => {
		var module = { exports: {} };

		const css = [
			'[class*="_thinkBody"]{',
			"max-height:var(--claude-driver-think-max-height,320px);",
			"overflow-y:auto;",
			"overscroll-behavior:contain;",
			"}",
		].join("");

		const tagId = "dsh-claude-driver/reasoning-cap.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-claude-driver";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Follow-the-tail: while reasoning text streams into a capped body, keep
		 * it pinned to the bottom so the newest thought stays visible — unless
		 * the user has scrolled up to read something, in which case leave them
		 * alone until they return to the bottom themselves.
		 *
		 * Pinning is self-consistent without a "programmatic scroll" flag: every
		 * scroll event (ours or the user's) re-derives pinned-ness from whether
		 * the box is near the bottom. Our own pin-to-bottom therefore re-asserts
		 * pinned=true; a user scrolling up flips it to false; scrolling back
		 * down re-arms it.
		 */
		const NEAR_BOTTOM_PX = 24;
		const pinned = new WeakMap();
		const isThinkBody = (el) => el instanceof Element && /(?:^|\s)[^\s]*_thinkBody(?:\s|$)/.test(el.className || "");

		if (typeof document !== "undefined") {
			document.addEventListener(
				"scroll",
				(event) => {
					const el = event.target;
					if (!isThinkBody(el)) return;
					pinned.set(el, el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX);
				},
				{ capture: true, passive: true },
			);

			let scheduled = false;
			const followTails = () => {
				scheduled = false;
				for (const el of document.querySelectorAll('[class*="_thinkBody"]')) {
					if (el.scrollHeight <= el.clientHeight) continue;
					if (pinned.get(el) === false) continue;
					el.scrollTop = el.scrollHeight;
				}
			};
			const observer = new MutationObserver(() => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(followTails);
			});
			const start = () => observer.observe(document.body, { childList: true, characterData: true, subtree: true });
			if (document.body) start();
			else document.addEventListener("DOMContentLoaded", start, { once: true });
		}

		const USAGE_ROUTE = "/claude-usage.json";
		const USAGE_POLL_MS = 15000;
		const WINDOW_LABELS = [
			["fiveHour", "5h", "5-hour window"],
			["weekly", "Week", "Week window"],
		];

		/**
		 * The bar's content, as plain data: the label, the session price for the
		 * card ("n/a" when unpriced, null before any turn) and the plan windows that
		 * Claude reports, rounded.
		 */
		function barSegments({ stats, snapshot }) {
			const cost = stats ? (stats.costUsd === null ? "n/a" : `$${stats.costUsd.toFixed(4)}`) : null;
			const windows = snapshot?.ok === true
				? WINDOW_LABELS.filter(([key]) => snapshot.windows?.[key]).map(([key, label, title]) => {
						const raw = snapshot.windows[key].percent;
						return { key, label, title, percent: Math.round(raw), tone: raw >= 90 ? "danger" : raw >= 70 ? "warn" : "", resetsAt: snapshot.windows[key].resetsAt };
					})
				: [];
			return { label: "Claude", cost, windows };
		}

		const usageResetIn = (iso) => {
			const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
			if (!Number.isFinite(minutes) || minutes <= 0) return "";
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.floor(minutes / 60);
			return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
		};
		const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
		const duration = (ms) => {
			const total = Math.max(0, Math.round(ms / 1000));
			return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
		};
		const TONE_COLOR = { danger: "#c53030", warn: "#b7791f", "": "inherit" };
		const MUTED = { color: "var(--dsw-alias-label-tertiary)" };

		function mountBar(require) {
			const React = require("react");
			const h = React.createElement;

			/** A small donut showing how much of a window is used, like the Go bar's rings. */
			const Ring = ({ percent, tone }) =>
				h(
					"svg",
					{ width: 12, height: 12, viewBox: "0 0 36 36", "aria-hidden": true, style: { transform: "rotate(-90deg)", verticalAlign: "-2px", marginRight: 4, color: TONE_COLOR[tone] } },
					h("circle", { cx: 18, cy: 18, r: 15.9, fill: "none", stroke: "currentColor", strokeOpacity: 0.25, strokeWidth: 4 }),
					h("circle", { cx: 18, cy: 18, r: 15.9, fill: "none", stroke: "currentColor", strokeWidth: 4, pathLength: 100, strokeDasharray: `${percent} 100` }),
				);

			/**
			 * One composer line: the Claude label, then the 5h and weekly rings. Click
			 * to expand the card with the session price and token detail.
			 */
			function ClaudeBar({ useProjection }) {
				const stats = useProjection("claudeSessionStats");
				const [snapshot, setSnapshot] = React.useState(null);
				const [open, setOpen] = React.useState(false);
				React.useEffect(() => {
					let alive = true;
					const load = () =>
						fetch(USAGE_ROUTE, { cache: "no-store", headers: { accept: "application/json" } })
							.then((response) => response.json())
							.then((payload) => {
								if (alive && payload?.snapshot) setSnapshot(payload.snapshot);
							})
							.catch(() => {});
					void load();
					const timer = setInterval(load, USAGE_POLL_MS);
					return () => {
						alive = false;
						clearInterval(timer);
					};
				}, []);
				const bar = barSegments({ stats, snapshot });
				if (bar.windows.length === 0) return null;

				const items = [h("span", { key: "label" }, h("span", { style: { color: "#d97757", marginRight: 4 } }, "●"), bar.label)];
				for (const w of bar.windows) {
					items.push(h("span", { key: w.key, style: { color: TONE_COLOR[w.tone] } }, h(Ring, { percent: w.percent, tone: w.tone }), `${w.label} ${w.percent}%`));
				}
				const line = items.flatMap((item, i) => (i === 0 ? [item] : [h("span", { key: `sep${i}`, style: MUTED }, " · "), item]));

				const card = [];
				if (stats) {
					card.push(["Session price (est.)", stats.costUsd === null ? "n/a" : `$${stats.costUsd.toFixed(4)}`]);
					card.push(["Duration", `API ${duration(stats.durationApiMs)} · wall ${duration(stats.durationMs)}`]);
					card.push(["Requests", String(stats.requests)]);
					card.push(["Cache hit", `${Math.round(stats.cache.hitRate * 100)}% · read ${k(stats.cache.readTokens)} · write ${k(stats.cache.writeTokens)}`]);
					for (const m of stats.models) card.push([m.model, `${k(m.inputTokens)} in · ${k(m.outputTokens)} out`]);
				}
				for (const w of bar.windows) {
					const resetIn = usageResetIn(w.resetsAt);
					card.push([w.title, `${w.percent}%${resetIn ? ` · resets in ${resetIn}` : ""}`]);
				}

				return h(
					"div",
					{ style: { position: "relative", width: "100%", fontSize: "12px", padding: "2px 12px" } },
					h(
						"button",
						{
							type: "button",
							"aria-expanded": open,
							title: "Claude Code session and plan usage",
							onClick: () => setOpen(!open),
							style: { background: "none", border: "none", padding: "2px 6px", cursor: "pointer", color: "inherit", font: "inherit", fontVariantNumeric: "tabular-nums", display: "inline-flex", alignItems: "center" },
						},
						line,
					),
					open
						? h(
								"div",
								{ style: { position: "absolute", bottom: "calc(100% + 8px)", right: 12, minWidth: 240, padding: "10px 12px", borderRadius: 8, background: "var(--dsw-alias-surface-elevated, #fff)", boxShadow: "0 6px 24px rgba(0,0,0,.18)", zIndex: 20 } },
								card.map(([label, value]) =>
									h("div", { key: label, style: { display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0" } }, h("span", { style: MUTED }, label), h("span", null, value)),
								),
							)
						: null,
				);
			}
			return ClaudeBar;
		}

		module.exports.name = "claude-driver-client";
		module.exports.inject = ["slots"];
		module.exports.barSegments = barSegments;
		module.exports.apply = (ctx) => {
			const ClaudeBar = mountBar(require);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "claude-driver-bar", order: 10 }, ClaudeBar),
			);
		};
		return module.exports;
	},
});
