(() => {
	const vscode = acquireVsCodeApi();

	const $ = (sel) => document.querySelector(sel);
	const $$ = (sel) => Array.from(document.querySelectorAll(sel));
	const listEl = $('#modelList');
	const searchEl = $('#search');
	const refreshEl = $('#refresh');
	const modelsStatusEl = $('#modelsStatus');

	const copilotDirectAuthToggleEl = $('#copilotDirectAuthToggle');
	const copilotDirectAuthDetailsEl = $('#copilotDirectAuthDetails');
	const copilotDirectAuthTextEl = $('#copilotDirectAuthText');
	const copilotDirectAuthHintEl = $('#copilotDirectAuthHint');
	const copilotDirectAuthRefreshEl = $('#copilotDirectAuthRefresh');
	const copilotDirectReloginMinimalEl = $('#copilotDirectReloginMinimal');
	const copilotDirectReloginPermissiveEl = $('#copilotDirectReloginPermissive');
	const copilotDirectSignOutEl = $('#copilotDirectSignOut');

	const navEls = $$('.navItem');
	const pages = $$('.page');

	const customAgentListEl = $('#customAgentList');
	const customAgentRefreshEl = $('#customAgentRefresh');
	const customAgentFileBaseEl = $('#customAgentFileBase');
	const customAgentCreateEl = $('#customAgentCreate');

	const builtinToolsEl = $('#builtinTools');
	const commandToolsEl = $('#commandTools');
	const mcpServersEl = $('#mcpServers');
	const mcpRefreshEl = $('#mcpRefresh');

	const agentProfileSelectEl = $('#agentProfileSelect');
	const agentProfileRemoveEl = $('#agentProfileRemove');
	const agentProfileIdEl = $('#agentProfileId');
	const agentProfileNameEl = $('#agentProfileName');
	const agentProfileAddEl = $('#agentProfileAdd');
	const followChatProfileEl = $('#followChatProfile');
	const syncChatProfileFromSettingsEl = $('#syncChatProfileFromSettings');
	const editsEnableHealingEl = $('#editsEnableHealing');
	const profileEditsEnableHealingModeEl = $('#profileEditsEnableHealingMode');

	const cmdToolNameEl = $('#cmdToolName');
	const cmdToolCommandEl = $('#cmdToolCommand');
	const cmdToolDescEl = $('#cmdToolDesc');
	const cmdToolAddEl = $('#cmdToolAdd');
	const cmdDiscoverQueryEl = $('#cmdDiscoverQuery');
	const cmdDiscoverEl = $('#cmdDiscover');
	const cmdDiscoverListEl = $('#cmdDiscoverList');

	const mcpIdEl = $('#mcpId');
	const mcpNameEl = $('#mcpName');
	const mcpTransportEl = $('#mcpTransport');
	const mcpUrlEl = $('#mcpUrl');
	const mcpCommandEl = $('#mcpCommand');
	const mcpArgsEl = $('#mcpArgs');
	const mcpAddEl = $('#mcpAdd');

	let allModels = [];
	let enabledIds = new Set();
	let modelsStatus = '';
		function renderModelsStatus() {
			if (!modelsStatusEl) return;
			const text = String(modelsStatus || '').trim();
			if (!text) {
				modelsStatusEl.textContent = '';
				return;
			}
			const parts = text.split(' · ').map((s) => String(s || '').trim()).filter(Boolean);
			const lines = [];
			lines.push('Models:');
			for (let i = 0; i < parts.length; i++) {
				const p = parts[i];
				if (i === 0 && !/[=:]/.test(p)) {
					lines.push(`provider: ${p}`);
				} else {
					lines.push(p);
				}
			}
			modelsStatusEl.textContent = lines.join('\n');
		}
	let builtinTools = [];
	let builtinToolCategories = {};
	let commandTools = [];
	let mcpServers = [];
	let discoveredCommands = [];
	let agentProfiles = [];
	let activeAgentProfileId = 'agent-vm';
	let followChatProfile = true;
	let syncChatProfileFromSettings = false;
	let editsEnableHealing = false;
	let profileEditsEnableHealingMode = 'inherit';
	let customAgents = [];
	let copilotDirectAuthStatus = null;
	let copilotDirectAuthExpanded = false;

	function renderFollowChatProfile() {
		if (!followChatProfileEl) return;
		followChatProfileEl.checked = !!followChatProfile;
	}

	function renderSyncChatProfileFromSettings() {
		if (!syncChatProfileFromSettingsEl) return;
		syncChatProfileFromSettingsEl.checked = !!syncChatProfileFromSettings;
	}

	function renderEditsEnableHealing() {
		if (!editsEnableHealingEl) return;
		editsEnableHealingEl.checked = !!editsEnableHealing;
	}

	function renderProfileEditsEnableHealingMode() {
		if (!profileEditsEnableHealingModeEl) return;
		const p = agentProfiles.find((x) => String(x?.id) === String(activeAgentProfileId));
		const v = p && Object.prototype.hasOwnProperty.call(p, 'editsEnableHealing') ? p.editsEnableHealing : undefined;
		profileEditsEnableHealingMode = v === true ? 'on' : v === false ? 'off' : 'inherit';
		profileEditsEnableHealingModeEl.value = profileEditsEnableHealingMode;
	}

	function setCopilotDirectAuthExpanded(next) {
		copilotDirectAuthExpanded = !!next;
		if (copilotDirectAuthDetailsEl) copilotDirectAuthDetailsEl.classList.toggle('hidden', !copilotDirectAuthExpanded);
		if (copilotDirectAuthToggleEl) copilotDirectAuthToggleEl.textContent = copilotDirectAuthExpanded ? 'Hide' : 'Show';
	}

	function renderCopilotDirectAuth() {
		if (!copilotDirectAuthTextEl) return;
		const s = copilotDirectAuthStatus;
		if (!s) {
			copilotDirectAuthTextEl.textContent = 'Unknown';
			if (copilotDirectAuthHintEl) copilotDirectAuthHintEl.textContent = '';
			return;
		}

		const lines = [];
		lines.push(`authMode: ${s.authMode || ''}`);
		lines.push(`tokenUrl override: ${s.tokenUrlOverrideEnabled ? 'enabled' : 'disabled'}${s.tokenUrlOverride ? `\n${s.tokenUrlOverride}` : ''}`);
		lines.push(
			`preferred: ${
				s.preferredSource
					? `${s.preferredSource}${s.preferredAccountLabel ? ` (${s.preferredAccountLabel})` : ''}`
					: 'none'
			}`
		);

		if (s.vscodeAuthAvailable) {
			const vs = s.vscodeAuthHasSession ? `yes${s.vscodeAuthAccountLabel ? ` (${s.vscodeAuthAccountLabel})` : ''}` : 'no';
			lines.push(`vscode-auth session: ${vs}`);
			if (s.vscodeAuthError) lines.push(`vscode-auth err: ${s.vscodeAuthError}`);
		} else {
			lines.push('vscode-auth: unavailable');
		}

		lines.push(
			`device-flow: ${s.deviceFlowEnabled ? 'enabled' : 'disabled'}` +
				`\nclientId: ${s.deviceFlowClientIdConfigured ? 'configured' : 'missing'}` +
				`\ncached: ${s.deviceFlowHasCachedToken ? `yes${s.deviceFlowAccountLabel ? ` (${s.deviceFlowAccountLabel})` : ''}` : 'no'}`
		);

		copilotDirectAuthTextEl.textContent = lines.join('\n');

		if (copilotDirectAuthHintEl) {
			let hint = '';
			if (!s.vscodeAuthAvailable && (!s.deviceFlowEnabled || !s.deviceFlowClientIdConfigured)) {
				hint = '提示：当前环境缺少 VS Code GitHub 认证；如需使用 device-flow，请配置 tripilot.copilotDirect.deviceFlow.clientId。';
			} else if (!s.preferredSource) {
				hint = '尚未登录。可以点击 Clear + Re-login 进行登录。';
			}
			copilotDirectAuthHintEl.textContent = hint;
		}
	}

	function renderCustomAgents() {
		if (!customAgentListEl) return;
		customAgentListEl.innerHTML = '';
		if (!customAgents.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No custom agents found in .github/agents.';
			customAgentListEl.appendChild(div);
			return;
		}

		for (const a of customAgents) {
			const row = document.createElement('div');
			row.className = 'row';
			row.dataset.id = String(a.id);

			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = a.name || a.id;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			const parts = [a.relativePath];
			if (a.isLegacy) parts.push('legacy');
			if (a.model) parts.push(`model: ${a.model}`);
			if (Array.isArray(a.tools) && a.tools.length) parts.push(`tools: ${a.tools.join(', ')}`);
			if (a.hidden) parts.push('hidden');
			meta.textContent = parts.join(' · ');
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const openBtn = document.createElement('button');
			openBtn.className = 'ghost';
			openBtn.textContent = 'Open';
			openBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'openWorkspaceCustomAgent', id: a.id });
			});

			const hideBtn = document.createElement('button');
			hideBtn.className = 'ghost';
			hideBtn.textContent = a.hidden ? 'Show' : 'Hide';
			hideBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'setWorkspaceCustomAgentHidden', id: a.id, hidden: !a.hidden });
			});

			const delBtn = document.createElement('button');
			delBtn.className = 'ghost';
			delBtn.textContent = 'Delete';
			delBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'deleteWorkspaceCustomAgent', id: a.id });
			});

			right.appendChild(openBtn);
			right.appendChild(hideBtn);
			right.appendChild(delBtn);

			row.appendChild(left);
			row.appendChild(right);
			customAgentListEl.appendChild(row);
		}
	}

	function renderAgentProfiles() {
		if (!agentProfileSelectEl) return;
		agentProfileSelectEl.innerHTML = '';
		for (const p of agentProfiles) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.name;
			agentProfileSelectEl.appendChild(opt);
		}
		agentProfileSelectEl.value = activeAgentProfileId;
		// Only allow removing non-default profiles.
		const isBuiltin = ['ask-study', 'edit-test', 'agent-vm'].includes(activeAgentProfileId);
		if (agentProfileRemoveEl) agentProfileRemoveEl.disabled = isBuiltin;
	}

	function normalize(s) {
		return String(s ?? '').toLowerCase();
	}

	function render() {
		const q = normalize(searchEl.value).trim();
		const filtered = q
			? allModels.filter((m) => normalize(m.name).includes(q) || normalize(m.id).includes(q) || normalize(m.vendor).includes(q))
			: allModels;

		listEl.innerHTML = '';
		if (!filtered.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No models.';
			listEl.appendChild(div);
			return;
		}

		for (const m of filtered) {
			const row = document.createElement('div');
			row.className = 'row';

			const left = document.createElement('div');

			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = m.name;

			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			meta.textContent = `${m.id}${m.vendor ? ` · ${m.vendor}` : ''}`;

			left.appendChild(name);
			left.appendChild(meta);

			const toggle = document.createElement('label');
			toggle.className = 'toggle';

			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = enabledIds.has(m.id);
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'toggleModel', id: m.id, enabled: input.checked });
			});

			const slider = document.createElement('span');
			slider.className = 'slider';

			toggle.appendChild(input);
			toggle.appendChild(slider);

			row.appendChild(left);
			row.appendChild(toggle);
			listEl.appendChild(row);
		}
	}

	function setPage(page) {
		for (const el of navEls) {
			const active = el.getAttribute('data-page') === page;
			el.classList.toggle('active', active);
		}
		for (const p of pages) {
			const show = p.getAttribute('data-page') === page;
			p.classList.toggle('hidden', !show);
		}
	}

	function renderBuiltinTools() {
		if (!builtinToolsEl) return;
		builtinToolsEl.innerHTML = '';
		if (!builtinTools.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No built-in tools.';
			builtinToolsEl.appendChild(div);
			return;
		}

		const GROUP_ORDER = ['agent', 'edit', 'execute', 'read', 'search', 'todo', 'vscode', 'web'];
		const GROUP_LABEL = {
			agent: 'agent',
			edit: 'edit',
			execute: 'execute',
			read: 'read',
			search: 'search',
			todo: 'todo',
			vscode: 'vscode',
			web: 'web'
		};
		const GROUP_DESC = {
			agent: 'Run subagents',
			edit: 'Edit files',
			execute: 'Run tasks/commands',
			read: 'Read from VS Code',
			search: 'Search the workspace',
			todo: 'Progress tracking',
			vscode: 'Use VS Code features',
			web: '从 Web 提取信息'
		};

		const map = builtinToolCategories && typeof builtinToolCategories === 'object' ? builtinToolCategories : {};
		const buckets = new Map();
		for (const t of builtinTools) {
			const catRaw = map[t.name];
			const cat = GROUP_ORDER.includes(String(catRaw)) ? String(catRaw) : null;
			if (!cat) continue;
			if (!buckets.has(cat)) buckets.set(cat, []);
			buckets.get(cat).push(t);
		}
		for (const tools of buckets.values()) {
			tools.sort((a, b) => String(a.name).localeCompare(String(b.name)));
		}

		const renderToolRow = (t) => {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = t.name;
			left.appendChild(name);
			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!t.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setBuiltinToolEnabled', name: t.name, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);
			row.appendChild(left);
			row.appendChild(toggle);
			return row;
		};

		for (const cat of GROUP_ORDER) {
			const tools = buckets.get(cat);
			if (!tools || !tools.length) continue;

			const details = document.createElement('details');
			details.className = 'toolGroup';
			details.open = true;

			const summary = document.createElement('summary');
			summary.className = 'toolGroupSummary';

			const arrow = document.createElement('span');
			arrow.className = 'codicon codicon-chevron-right toolGroupArrow';

			const title = document.createElement('div');
			title.className = 'toolGroupTitle';
			title.textContent = `${GROUP_LABEL[cat] || cat} ${GROUP_DESC[cat] ? GROUP_DESC[cat] : ''}`.trim();

			const meta = document.createElement('div');
			meta.className = 'toolGroupMeta';
			meta.textContent = `${tools.length} tools`;

			summary.appendChild(arrow);
			summary.appendChild(title);
			summary.appendChild(meta);
			details.appendChild(summary);

			const list = document.createElement('div');
			list.className = 'list toolGroupList';
			for (const t of tools) {
				list.appendChild(renderToolRow(t));
			}
			details.appendChild(list);

			builtinToolsEl.appendChild(details);
		}
	}

	function renderCommandTools() {
		if (!commandToolsEl) return;
		commandToolsEl.innerHTML = '';
		if (!commandTools.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No command tools.';
			commandToolsEl.appendChild(div);
			return;
		}
		for (const t of commandTools) {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = t.name;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			meta.textContent = `${t.command}${t.description ? ` · ${t.description}` : ''}`;
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!t.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setCommandToolEnabled', name: t.name, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);

			const remove = document.createElement('button');
			remove.className = 'ghost';
			remove.textContent = 'Remove';
			remove.addEventListener('click', () => {
				vscode.postMessage({ type: 'removeCommandTool', name: t.name });
			});

			right.appendChild(toggle);
			right.appendChild(remove);

			row.appendChild(left);
			row.appendChild(right);
			commandToolsEl.appendChild(row);
		}
	}

	function toolNameFromCommandId(commandId) {
		const raw = String(commandId ?? '').trim();
		if (!raw) return '';
		const base = raw
			.split('.')
			.slice(-2)
			.join('_')
			.replace(/[^A-Za-z0-9_.\-]/g, '_');
		let name = base || raw.replace(/[^A-Za-z0-9_.\-]/g, '_');
		const existing = new Set((commandTools || []).map((t) => String(t?.name ?? '')));
		if (!existing.has(name)) return name;
		let i = 2;
		while (existing.has(`${name}_${i}`)) i++;
		return `${name}_${i}`;
	}

	function renderDiscoveredCommands() {
		if (!cmdDiscoverListEl) return;
		cmdDiscoverListEl.innerHTML = '';
		if (!discoveredCommands.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No command search results.';
			cmdDiscoverListEl.appendChild(div);
			return;
		}

		for (const id of discoveredCommands) {
			const row = document.createElement('div');
			row.className = 'row';

			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = id;
			left.appendChild(name);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const add = document.createElement('button');
			add.className = 'ghost';
			add.textContent = 'Add as Tool';
			add.addEventListener('click', () => {
				const toolName = toolNameFromCommandId(id);
				if (!toolName) return;
				vscode.postMessage({
					type: 'addCommandTool',
					tool: { name: toolName, command: id, description: undefined, enabled: true }
				});
			});

			right.appendChild(add);
			row.appendChild(left);
			row.appendChild(right);
			cmdDiscoverListEl.appendChild(row);
		}
	}

	function renderMcpServers() {
		if (!mcpServersEl) return;
		mcpServersEl.innerHTML = '';
		if (!mcpServers.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No MCP servers.';
			mcpServersEl.appendChild(div);
			return;
		}
		for (const s of mcpServers) {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = s.name;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			const statusText = s.status === 'connected'
				? `Connected · ${s.toolCount} tools`
				: s.status === 'connecting'
				? 'Connecting…'
				: s.status === 'error'
				? `Error${s.lastError ? ` · ${s.lastError}` : ''}`
				: 'Disconnected';
			meta.textContent = `${s.id} · ${s.transport} · ${statusText}`;
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';
			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!s.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setMcpServerEnabled', id: s.id, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);

			const remove = document.createElement('button');
			remove.className = 'ghost';
			remove.textContent = 'Remove';
			remove.addEventListener('click', () => {
				vscode.postMessage({ type: 'removeMcpServer', id: s.id });
			});

			right.appendChild(toggle);
			right.appendChild(remove);

			row.appendChild(left);
			row.appendChild(right);
			mcpServersEl.appendChild(row);
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;

		switch (msg.type) {
			case 'init':
				allModels = Array.isArray(msg.models) ? msg.models : [];
				enabledIds = new Set(Array.isArray(msg.visibleModelIds) ? msg.visibleModelIds : []);
				modelsStatus = msg.modelsStatus ?? modelsStatus;
				copilotDirectAuthStatus = msg.copilotDirectAuthStatus ?? copilotDirectAuthStatus;
				agentProfiles = Array.isArray(msg.agentProfiles) ? msg.agentProfiles : [];
				activeAgentProfileId = String(msg.activeAgentProfileId || activeAgentProfileId);
				followChatProfile = msg.followChatProfile !== undefined ? !!msg.followChatProfile : followChatProfile;
				syncChatProfileFromSettings = msg.syncChatProfileFromSettings !== undefined ? !!msg.syncChatProfileFromSettings : syncChatProfileFromSettings;
				editsEnableHealing = msg.editsEnableHealing !== undefined ? !!msg.editsEnableHealing : editsEnableHealing;
				builtinTools = Array.isArray(msg.builtinTools) ? msg.builtinTools : [];
				builtinToolCategories = msg.builtinToolCategories && typeof msg.builtinToolCategories === 'object' ? msg.builtinToolCategories : {};
				commandTools = Array.isArray(msg.commandTools) ? msg.commandTools : [];
				mcpServers = Array.isArray(msg.mcpServers) ? msg.mcpServers : [];
				customAgents = Array.isArray(msg.customAgents) ? msg.customAgents : [];
				renderAgentProfiles();
				renderFollowChatProfile();
				renderSyncChatProfileFromSettings();
				renderEditsEnableHealing();
				renderProfileEditsEnableHealingMode();
				renderCopilotDirectAuth();
				renderModelsStatus();
				render();
				renderBuiltinTools();
				renderCommandTools();
				renderMcpServers();
				renderCustomAgents();
				renderDiscoveredCommands();
				if (msg.initialPage) {
					setPage(String(msg.initialPage));
				}
				return;
			case 'update':
				allModels = Array.isArray(msg.models) ? msg.models : allModels;
				enabledIds = new Set(Array.isArray(msg.visibleModelIds) ? msg.visibleModelIds : Array.from(enabledIds));
				modelsStatus = msg.modelsStatus ?? modelsStatus;
				copilotDirectAuthStatus = msg.copilotDirectAuthStatus ?? copilotDirectAuthStatus;
				agentProfiles = Array.isArray(msg.agentProfiles) ? msg.agentProfiles : agentProfiles;
				activeAgentProfileId = msg.activeAgentProfileId ? String(msg.activeAgentProfileId) : activeAgentProfileId;
				followChatProfile = msg.followChatProfile !== undefined ? !!msg.followChatProfile : followChatProfile;
				syncChatProfileFromSettings = msg.syncChatProfileFromSettings !== undefined ? !!msg.syncChatProfileFromSettings : syncChatProfileFromSettings;
				editsEnableHealing = msg.editsEnableHealing !== undefined ? !!msg.editsEnableHealing : editsEnableHealing;
				builtinTools = Array.isArray(msg.builtinTools) ? msg.builtinTools : builtinTools;
				builtinToolCategories = msg.builtinToolCategories && typeof msg.builtinToolCategories === 'object' ? msg.builtinToolCategories : builtinToolCategories;
				commandTools = Array.isArray(msg.commandTools) ? msg.commandTools : commandTools;
				mcpServers = Array.isArray(msg.mcpServers) ? msg.mcpServers : mcpServers;
				customAgents = Array.isArray(msg.customAgents) ? msg.customAgents : customAgents;
				renderAgentProfiles();
				renderFollowChatProfile();
				renderSyncChatProfileFromSettings();
				renderEditsEnableHealing();
				renderProfileEditsEnableHealingMode();
				renderCopilotDirectAuth();
				renderModelsStatus();
				render();
				renderBuiltinTools();
				renderCommandTools();
				renderMcpServers();
				renderCustomAgents();
				renderDiscoveredCommands();
				return;
			case 'setPage':
				setPage(String(msg.page || 'models'));
				return;
			case 'discoveredCommands':
				discoveredCommands = Array.isArray(msg.commands) ? msg.commands : [];
				renderDiscoveredCommands();
				return;
		}
	});

	copilotDirectAuthToggleEl?.addEventListener('click', () => {
		setCopilotDirectAuthExpanded(!copilotDirectAuthExpanded);
	});

	copilotDirectAuthRefreshEl?.addEventListener('click', () => {
		vscode.postMessage({ type: 'copilotDirectRefreshAuthStatus' });
	});
	const relogin = (authMode) => {
		vscode.postMessage({ type: 'copilotDirectRelogin', authMode });
	};
	copilotDirectReloginMinimalEl?.addEventListener('click', () => relogin('minimal'));
	copilotDirectReloginPermissiveEl?.addEventListener('click', () => relogin('permissive'));
	copilotDirectSignOutEl?.addEventListener('click', () => {
		vscode.postMessage({ type: 'copilotDirectSignOut' });
	});

	searchEl.addEventListener('input', () => render());
	refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

	for (const el of navEls) {
		el.addEventListener('click', () => {
			const page = el.getAttribute('data-page') || 'models';
			setPage(page);
		});
	}

	agentProfileSelectEl?.addEventListener('change', () => {
		const id = String(agentProfileSelectEl.value || '').trim();
		if (!id) return;
		activeAgentProfileId = id;
		vscode.postMessage({ type: 'setActiveAgentProfile', id });
		renderProfileEditsEnableHealingMode();
	});

	followChatProfileEl?.addEventListener('change', () => {
		followChatProfile = !!followChatProfileEl.checked;
		vscode.postMessage({ type: 'setFollowChatProfile', enabled: followChatProfile });
	});

	syncChatProfileFromSettingsEl?.addEventListener('change', () => {
		syncChatProfileFromSettings = !!syncChatProfileFromSettingsEl.checked;
		vscode.postMessage({ type: 'setSyncChatProfileFromSettings', enabled: syncChatProfileFromSettings });
	});

	editsEnableHealingEl?.addEventListener('change', () => {
		editsEnableHealing = !!editsEnableHealingEl.checked;
		vscode.postMessage({ type: 'setEditsEnableHealing', enabled: editsEnableHealing });
	});

	profileEditsEnableHealingModeEl?.addEventListener('change', () => {
		const mode = String(profileEditsEnableHealingModeEl.value || 'inherit');
		profileEditsEnableHealingMode = mode;
		vscode.postMessage({
			type: 'setAgentProfileEditsEnableHealing',
			id: activeAgentProfileId,
			mode: mode === 'on' ? 'on' : mode === 'off' ? 'off' : 'inherit'
		});
	});

	agentProfileAddEl?.addEventListener('click', () => {
		const id = String(agentProfileIdEl?.value ?? '').trim();
		const name = String(agentProfileNameEl?.value ?? '').trim();
		if (!id || !name) return;
		vscode.postMessage({ type: 'addAgentProfile', profile: { id, name } });
		agentProfileIdEl.value = '';
		agentProfileNameEl.value = '';
	});

	agentProfileRemoveEl?.addEventListener('click', () => {
		const id = String(activeAgentProfileId || '').trim();
		if (!id) return;
		vscode.postMessage({ type: 'removeAgentProfile', id });
	});

	cmdToolAddEl?.addEventListener('click', () => {
		const name = String(cmdToolNameEl?.value ?? '').trim();
		const command = String(cmdToolCommandEl?.value ?? '').trim();
		const description = String(cmdToolDescEl?.value ?? '').trim();
		if (!name || !command) return;
		vscode.postMessage({
			type: 'addCommandTool',
			tool: { name, command, description: description || undefined, enabled: true }
		});
		cmdToolNameEl.value = '';
		cmdToolCommandEl.value = '';
		cmdToolDescEl.value = '';
	});

	cmdDiscoverEl?.addEventListener('click', () => {
		const query = String(cmdDiscoverQueryEl?.value ?? '').trim();
		vscode.postMessage({ type: 'discoverCommands', query });
	});
	cmdDiscoverQueryEl?.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		const query = String(cmdDiscoverQueryEl?.value ?? '').trim();
		vscode.postMessage({ type: 'discoverCommands', query });
	});

	mcpAddEl?.addEventListener('click', () => {
		const id = String(mcpIdEl?.value ?? '').trim();
		const name = String(mcpNameEl?.value ?? '').trim();
		const transport = String(mcpTransportEl?.value ?? 'stdio');
		const url = String(mcpUrlEl?.value ?? '').trim();
		const command = String(mcpCommandEl?.value ?? '').trim();
		const argsText = String(mcpArgsEl?.value ?? '').trim();
		let args;
		if (argsText) {
			try {
				args = JSON.parse(argsText);
				if (!Array.isArray(args)) args = undefined;
			} catch {
				args = undefined;
			}
		}
		if (!id || !name) return;
		vscode.postMessage({
			type: 'upsertMcpServer',
			server: {
				id,
				name,
				transport,
				enabled: true,
				url: url || undefined,
				command: command || undefined,
				args
			}
		});
	});

	mcpRefreshEl?.addEventListener('click', () => vscode.postMessage({ type: 'refreshToolsAndMcp' }));

	customAgentRefreshEl?.addEventListener('click', () => vscode.postMessage({ type: 'refreshCustomAgents' }));
	customAgentCreateEl?.addEventListener('click', () => {
		const base = String(customAgentFileBaseEl?.value ?? '').trim();
		if (!base) return;
		vscode.postMessage({ type: 'createWorkspaceCustomAgent', fileBaseName: base });
		customAgentFileBaseEl.value = '';
	});

	setPage('models');
	setCopilotDirectAuthExpanded(false);

	vscode.postMessage({ type: 'webviewReady' });
})();
