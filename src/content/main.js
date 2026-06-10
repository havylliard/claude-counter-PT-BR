(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}
			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}
	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;
		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};
		window.addEventListener('cc:urlchange', fireIfChanged);
		window.addEventListener('popstate', fireIfChanged);
		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;
		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};
		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);
		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;
		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};
		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);
		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;
	let usageState = null;
	let usageResetMs = { five_hour: null, seven_day: null };
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };
	const ui = new CC.ui.CounterUI({ onUsageRefresh: async () => { await refreshUsage(); } });
	ui.initialize();
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);
		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}
		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);
		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;
		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();
		waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => { if (el) ui.attachUsageLine(); });
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => { if (el) ui.attachHeader(); });
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}
		updateOrgIdIfNeeded(getOrgIdFromCookie());
		await refreshConversation();
		if (!usageState) await refreshUsage();
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;
		const originalText = indicator.textContent;
		if (branchObserver) branchObserver.disconnect();
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});
		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	handleUrlChange();

	function tick() {
		ui.tick();
		const now = Date.now();
		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	setInterval(tick, 1000);

	// ========== CSS MODIFICADO ==========
	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = `
/* Header: tokens + cache timer */
.cc-header {
	margin-top: 2px;
	user-select: none;
}
.cc-headerItem {
	white-space: nowrap;
}
.cc-usageRow {
	position: relative;
	z-index: 50;
	cursor: pointer;
	user-select: none;
	transition: opacity 150ms ease;
}
.cc-usageRow--dim {
	opacity: 0.6;
}
.cc-usageGroup {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 1;
	min-width: 0;
}
.cc-usageGroup--single {
	width: 100%;
}
.cc-usageGroup--weekly {
	justify-content: flex-end;
}
.cc-usageText {
	white-space: nowrap;
}
/* Estilo base da barra */
.cc-bar {
	--cc-radius: 3px;
	--cc-stroke: #555;
	--cc-marker: white;
	position: relative;
	box-sizing: border-box;
	width: 100%;
	height: 10px;
	border-radius: var(--cc-radius);
	border: 1px solid var(--cc-stroke);
	overflow: visible;
	user-select: none;
	background: #2a2a2a;
}
/* Gradiente padrão para uso (verde -> vermelho) */
.cc-bar--usage {
	background: linear-gradient(to right, #4caf50, #ffeb3b, #f44336);
}
/* Gradiente invertido para a barra de sessão (vermelho -> verde) */
.cc-bar--session {
	background: linear-gradient(to right, #f44336, #ffeb3b, #4caf50);
}
/* O preenchimento fica oculto – usamos apenas a bolinha como indicador de uso */
.cc-bar__fill {
	display: none;
}
/* Bolinha indicadora (uso) */
.cc-bar__marker {
	position: absolute;
	top: 50%;
	transform: translate(-50%, -50%);
	left: 0%;
	width: 12px;
	height: 12px;
	background: var(--cc-marker);
	border-radius: 50%;
	box-shadow: 0 0 3px rgba(0,0,0,0.5);
	pointer-events: none;
	transition: left 300ms ease;
	z-index: 2;
}
/* Mini bar (tokens) – mantém o comportamento original (preenchimento progressivo) */
.cc-bar--mini {
	width: 60px;
	height: 7px;
	--cc-radius: 2px;
	background: #2a2a2a;
}
.cc-bar--mini .cc-bar__fill {
	display: block;
	background: linear-gradient(to right, #4caf50, #ffeb3b, #f44336);
	width: 0%;
	height: 100%;
	transition: width 300ms ease;
	border-radius: var(--cc-radius);
}
.cc-bar--mini .cc-bar__marker {
	display: none;
}
.cc-tooltip {
	position: fixed;
	z-index: 9999;
	padding: 4px 8px;
	border-radius: 4px;
	font-size: 12px;
	white-space: pre-line;
	user-select: none;
	pointer-events: none;
	opacity: 0;
	transition: opacity 200ms ease;
}
.cc-tooltipTrigger {
	-webkit-touch-callout: none;
	-webkit-user-select: none;
	user-select: none;
	cursor: help;
}
.cc-hidden {
	display: none !important;
}`;

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}
	injectStyles();
})();