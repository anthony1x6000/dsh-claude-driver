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

		const React = require("react");
		const h = React.createElement;
		const STATS_URL = "/claude-driver/api/session-stats";
		const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
		const money = (usd) => `$${usd.toFixed(4)}`;
		const duration = (ms) => {
			const total = Math.max(0, Math.round(ms / 1000));
			return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
		};

		/**
		 * Composer stats line for Claude Code sessions: one compact line of
		 * cost, API vs wall time and cache share; click to expand the /usage
		 * breakdown. Renders nothing for sessions the driver never ran.
		 */
		function SessionStats({ useSession }) {
			const sessionId = useSession((s) => s.id);
			const running = useSession((s) => s.running);
			const [stats, setStats] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			React.useEffect(() => {
				setStats(null);
				if (!sessionId) return undefined;
				let live = true;
				fetch(`${STATS_URL}?sessionId=${encodeURIComponent(sessionId)}`)
					.then((r) => (r.ok ? r.json() : null))
					.then((s) => {
						if (live) setStats(s);
					})
					.catch(() => {});
				return () => {
					live = false;
				};
			}, [sessionId, running]);
			if (!stats) return null;
			const cache = stats.cache;
			const summary = [
				"Claude Code",
				money(stats.costUsd),
				`API ${duration(stats.durationApiMs)} / wall ${duration(stats.durationMs)}`,
				`${Math.round(cache.hitRate * 100)}% cached`,
			].join(" · ");
			const rows = [
				`Total cost: ${money(stats.costUsd)}`,
				`Duration: API ${duration(stats.durationApiMs)} · wall ${duration(stats.durationMs)}`,
				`Requests: ${stats.requests}`,
				`Prompt cache: ${Math.round(cache.hitRate * 100)}% of input from cache · read ${k(cache.readTokens)} · write ${k(cache.writeTokens)}`,
				...stats.models.map(
					(m) =>
						`${m.model}: ${k(m.inputTokens)} in · ${k(m.outputTokens)} out · ${k(m.cacheReadTokens)} cache read · ${k(m.cacheWriteTokens)} cache write · ${money(m.costUsd)}`,
				),
			];
			return h(
				"div",
				{ "data-claude-driver-stats": true, style: { width: "100%", fontSize: "12px", padding: "2px 12px" } },
				h(
					"button",
					{
						type: "button",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						style: { background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit" },
					},
					summary,
				),
				open
					? h(
							"div",
							{ style: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" } },
							rows.map((row) => h("div", { key: row }, row)),
						)
					: null,
			);
		}

		module.exports.name = "claude-driver-client";
		module.exports.inject = ["slots"];
		module.exports.apply = (ctx) => {
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "claude-driver-session-stats", order: 10 }, SessionStats),
			);
		};
		return module.exports;
	},
});
