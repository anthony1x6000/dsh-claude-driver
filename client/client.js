/**
 * dsh-claude-driver client half: cap the expanded reasoning ("思考") body at a
 * max height and keep it scrolled to the latest text while streaming.
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
		const USAGE_CSS = [
			".cdu_root{position:relative}",
			".cdu_pill{display:inline-flex;align-items:center;gap:8px;border:none;background:none;cursor:pointer;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:var(--dsw-radius-sm)}",
			".cdu_pill:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".cdu_card{position:absolute;bottom:calc(100% + 8px);right:0;min-width:220px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-surface-elevated,#fff);box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:12px;color:var(--dsw-alias-label-primary);z-index:20}",
			".cdu_row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-variant-numeric:tabular-nums}",
			".cdu_muted{color:var(--dsw-alias-label-tertiary)}",
			".cdu_warn{color:#b7791f}",
			".cdu_danger{color:#c53030}",
		].join("");
		const usageTone = (percent) => (percent >= 90 ? "cdu_danger" : percent >= 70 ? "cdu_warn" : "");
		const usageResetIn = (iso) => {
			const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
			if (!Number.isFinite(minutes) || minutes <= 0) return "";
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.floor(minutes / 60);
			return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
		};

		/** Plan-usage meter in the composer dock: the 5h and weekly windows, with a click-open card. */
		function mountUsageMeter(ctx, require) {
			const React = require("react");
			const h = React.createElement;
			const PILL_WINDOWS = [["fiveHour", "5h"], ["weekly", "Week"]];
			const CARD_WINDOWS = [["fiveHour", "5-hour window"], ["weekly", "Week window"], ["weeklySonnet", "Sonnet week"], ["weeklyOpus", "Opus week"]];

			function UsageMeter() {
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
				if (snapshot?.ok !== true) return null;
				const windows = snapshot.windows ?? {};
				const pills = PILL_WINDOWS.filter(([key]) => windows[key]);
				if (pills.length === 0) return null;
				const card = CARD_WINDOWS.filter(([key]) => windows[key]);
				return h(
					"div",
					{ className: "cdu_root" },
					h(
						"button",
						{ type: "button", className: "cdu_pill", title: "Claude plan usage", onClick: () => setOpen(!open) },
						pills.map(([key, label]) => h("span", { key, className: usageTone(windows[key].percent) }, `${label} ${Math.round(windows[key].percent)}%`)),
					),
					open
						? h(
								"div",
								{ className: "cdu_card" },
								card.map(([key, label]) => {
									const { percent, resetsAt } = windows[key];
									const resetIn = usageResetIn(resetsAt);
									return h(
										"div",
										{ key, className: "cdu_row" },
										h("span", null, label),
										h("span", { className: usageTone(percent) }, `${Math.round(percent)}%${resetIn ? ` · resets in ${resetIn}` : ""}`),
									);
								}),
								snapshot.extra?.enabled
									? h(
											"div",
											{ className: "cdu_row cdu_muted" },
											h("span", null, "Extra usage"),
											h("span", null, snapshot.extra.percent == null ? "on" : `${Math.round(snapshot.extra.percent)}%`),
										)
									: null,
							)
						: null,
				);
			}

			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-claude-driver";
				tag.dataset.pluginCss = "claude-usage-meter.css";
				tag.textContent = USAGE_CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			});
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "claude-usage", order: 3 }, UsageMeter),
			);
		}

		return {
			name: "claude-driver-client",
			inject: ["slots"],
			apply: (ctx) => mountUsageMeter(ctx, require),
		};
	},
});
