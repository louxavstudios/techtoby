/* Shared account storage for every Techtoby page. Existing apps use localStorage as a cache. */
(() => {
    const API = 'https://api.louxav.com/accounts/';
    const KEY = '__ttcAccount';
    const nativeSet = Storage.prototype.setItem;
    const nativeRemove = Storage.prototype.removeItem;
    let timer, running = null, paused = false;
    let status = 'Guest — data is saved on this device';
    const state = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
    const persist = value => nativeSet.call(localStorage, KEY, JSON.stringify(value));
    function migrateLegacyProfiles() {
        const legacyKeys = Object.keys(localStorage).filter(key => key === 'ttcProfiles' || key === 'ttcActiveProfile' || key.startsWith('ttcData_'));
        if (!legacyKeys.length) return;
        const archived = Object.create(null);
        for (const key of legacyKeys) archived[key] = localStorage.getItem(key);
        const archiveKey = 'ttcLegacyProfiles';
        let archives;
        try { archives = JSON.parse(localStorage.getItem(archiveKey) || '[]'); } catch { archives = []; }
        if (!Array.isArray(archives)) archives = [archives];
        nativeSet.call(localStorage, archiveKey, JSON.stringify([...archives, archived]));
        let activeData;
        try { activeData = JSON.parse(archived['ttcData_' + archived.ttcActiveProfile] || '{}'); } catch { activeData = {}; }
        for (const [key, value] of Object.entries(activeData)) {
            if (!key.startsWith('__ttcAccount') && !legacyKeys.includes(key) && localStorage.getItem(key) === null && typeof value === 'string') nativeSet.call(localStorage, key, value);
        }
        if (!localStorage.getItem('bbAccountData')) nativeSet.call(localStorage, 'bbAccountData', JSON.stringify(activeData));
        for (const key of legacyKeys) nativeRemove.call(localStorage, key);
    }
    migrateLegacyProfiles();
    function snapshot() {
        const data = Object.create(null);
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key.startsWith('__ttcAccount')) data[key] = localStorage.getItem(key);
        }
        return data;
    }
    const same = (a, b) => {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...keys].every(key => a[key] === b[key]);
    };
    function apply(data) {
        for (const key of Object.keys(snapshot())) nativeRemove.call(localStorage, key);
        for (const [key, value] of Object.entries(data)) if (!key.startsWith('__ttcAccount') && typeof value === 'string') nativeSet.call(localStorage, key, value);
        migrateLegacyProfiles();
    }
    function notify(message) {
        status = message;
        document.querySelectorAll('[data-account-status]').forEach(el => el.textContent = message);
    }
    async function request(action, options = {}, token = state()?.token) {
        let response;
        try {
            response = await fetch(API + action, { ...options, headers: { ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers }, signal: AbortSignal.timeout(15000) });
        } catch { throw new Error('Cannot reach the account API. Check your connection and that this site origin is allowed by the API.'); }
        const result = await response.json().catch(() => ({ error: 'The account API returned an invalid response' }));
        if (!response.ok) throw Object.assign(new Error(result.error || 'Account request failed'), { status: response.status });
        return result;
    }
    const locked = work => navigator.locks ? navigator.locks.request('techtoby-account-storage', work) : work();
    function schedule() {
        if (!state()?.token || paused) return;
        notify('Saving to your account…');
        clearTimeout(timer);
        timer = setTimeout(() => sync().catch(() => {}), 1200);
    }
    async function sync() {
        if (paused) throw new Error('Cloud saving is paused. Log in again or reload cloud data in Settings.');
        if (running) { await running; return sync(); }
        try {
            running = locked(async () => {
                const current = state();
                if (!current?.token) return;
                const data = snapshot();
                if (same(data, current.base || {})) { notify('Saved to your account'); return; }
                const result = await request('data', { method: 'PUT', body: JSON.stringify({ data, revision: current.revision }) }, current.token);
                if (state()?.token !== current.token) return;
                persist({ ...state(), base: data, revision: result.revision });
                notify('Saved to your account');
                if (!same(snapshot(), data)) schedule();
            });
            await running;
        } catch (error) {
            if (error.status === 409 || error.status === 401) paused = true;
            notify(error.status === 409 ? 'Cloud data changed elsewhere. Open Settings to reload it; local changes are retained.' : error.status === 401 ? 'Login expired. Open Settings to log in again; local changes are retained.' : 'Not saved to cloud: ' + error.message + '. Local changes are retained.');
            throw error;
        } finally { running = null; }
    }
    Storage.prototype.setItem = function (key, value) {
        nativeSet.call(this, key, value);
        if (this === localStorage && !String(key).startsWith('__ttcAccount')) schedule();
    };
    Storage.prototype.removeItem = function (key) {
        nativeRemove.call(this, key);
        if (this === localStorage && !String(key).startsWith('__ttcAccount')) schedule();
    };
    const nativeClear = Storage.prototype.clear;
    Storage.prototype.clear = function () {
        if (this !== localStorage) return nativeClear.call(this);
        apply({});
        schedule();
    };
    async function refresh(discard = false) {
        await locked(async () => {
            const current = state();
            if (!current?.token) return;
            if (!discard && !same(snapshot(), current.base || {})) { schedule(); return; }
            const result = await request('me', {}, current.token);
            if (state()?.token !== current.token) return;
            // Do not overwrite changes made while the network request was in flight.
            if (!discard && !same(snapshot(), current.base || {})) { schedule(); return; }
            const changed = !same(snapshot(), result.data);
            apply(result.data);
            persist({ ...current, ...result, base: result.data });
            paused = false;
            notify('Saved to your account');
            if (changed) location.reload();
        });
    }
    async function authenticate(action, username, password) {
        const data = snapshot();
        const result = await request(action, { method: 'POST', body: JSON.stringify({ username, password, ...(action === 'register' ? { data } : {}) }) }, null);
        apply(result.data);
        persist({ token: result.token, account: result.account, base: result.data, revision: result.revision });
        paused = false;
        if (!same(snapshot(), result.data)) await sync();
        location.reload();
    }
    async function logout() {
        if (paused) throw new Error('Reload cloud data or log in again before logging out, so pending changes are not lost.');
        await sync();
        await request('logout', { method: 'POST', body: '{}' });
        nativeRemove.call(localStorage, KEY);
        apply({});
        location.reload();
    }
    async function uploadPicture(file) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) throw new Error('Profile pictures must be 5 MB or smaller');
        const current = state();
        if (!current?.token) throw new Error('Log in to change your profile picture');
        const result = await request('pfp', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }, current.token);
        if (state()?.token !== current.token) return;
        persist({ ...state(), account: result.account });
        mount();
        notify('Profile picture updated');
        return result.account.pfp;
    }
    async function searchRobloxUsers(query) {
        const result = await request('search?q=' + encodeURIComponent(query.trim()), {}, null);
        return result.users || [];
    }
    async function lookupRobloxUser(id) {
        const result = await request('roblox?id=' + encodeURIComponent(id), {}, null);
        return result.user;
    }
    function installRobloxLookupStyles() {
        if (document.getElementById('techtobyRobloxLookupStyles')) return;
        const style = document.createElement('style');
        style.id = 'techtobyRobloxLookupStyles';
        style.textContent = `.RobloxLookupHost{position:relative;width:100%}.RobloxLookupHost>input{box-sizing:border-box;width:100%}.RobloxLookupMenu{position:absolute;z-index:1000;top:calc(100% + 4px);left:0;right:0;display:none;max-height:190px;overflow:auto;padding:5px;background:rgba(250,250,252,.98);border:1px solid rgba(0,0,0,.14);border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.18);backdrop-filter:blur(16px)}.RobloxLookupMenu.open{display:grid;gap:2px}.RobloxLookupOption{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:transparent;color:rgba(0,0,0,.8);font:inherit;font-size:12px;text-align:left;cursor:pointer}.RobloxLookupOption:hover,.RobloxLookupOption:focus{background:rgba(99,102,241,.11);outline:none}.RobloxLookupOptionText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.RobloxLookupOptionUser{margin-left:auto;color:rgba(0,0,0,.48);white-space:nowrap}.RobloxLookupStatus{min-height:14px;margin-top:3px;color:rgba(0,0,0,.48);font-size:10px;line-height:1.3}`;
        document.head.append(style);
    }
    function bindRobloxAutocomplete(input, onSelect) {
        if (!input || input.dataset.robloxLookupBound) return;
        input.dataset.robloxLookupBound = 'true';
        installRobloxLookupStyles();
        const host = document.createElement('div');
        host.className = 'RobloxLookupHost';
        input.parentNode.insertBefore(host, input);
        host.append(input);
        const menu = document.createElement('div');
        menu.className = 'RobloxLookupMenu';
        menu.setAttribute('role', 'listbox');
        const status = document.createElement('div');
        status.className = 'RobloxLookupStatus';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        host.append(menu, status);
        let timer, version = 0;
        const close = () => { menu.classList.remove('open'); menu.replaceChildren(); };
        input.addEventListener('input', () => {
            delete input.dataset.robloxUserId;
            clearTimeout(timer);
            const current = ++version;
            close();
            const query = input.value.trim();
            status.textContent = query.length < 3 ? '' : 'Searching Roblox…';
            if (query.length < 3) return;
            timer = setTimeout(async () => {
                try {
                    const users = await searchRobloxUsers(query);
                    if (current !== version) return;
                    status.textContent = users.length ? '' : 'No Roblox users found.';
                    for (const user of users) {
                        const option = document.createElement('button');
                        option.type = 'button'; option.className = 'RobloxLookupOption'; option.setAttribute('role', 'option');
                        const display = document.createElement('span'); display.className = 'RobloxLookupOptionText'; display.textContent = user.displayName || user.username;
                        const username = document.createElement('span'); username.className = 'RobloxLookupOptionUser'; username.textContent = `@${user.username}`;
                        option.append(display, username);
                        option.addEventListener('click', async () => {
                            ++version; close(); input.value = user.username; input.disabled = true; status.textContent = 'Loading Roblox profile…';
                            try {
                                const profile = await lookupRobloxUser(user.id);
                                input.value = profile.username;
                                input.dataset.robloxUserId = String(profile.id);
                                await onSelect(profile);
                                status.textContent = `Selected @${profile.username}`;
                            } catch (error) { status.textContent = error.message; }
                            finally { input.disabled = false; }
                        });
                        menu.append(option);
                    }
                    menu.classList.toggle('open', users.length > 0);
                } catch (error) { if (current === version) status.textContent = error.message; }
            }, 300);
        });
        input.addEventListener('keydown', event => { if (event.key === 'Escape') { ++version; close(); } });
        document.addEventListener('pointerdown', event => { if (!host.contains(event.target)) close(); });
    }
    function mount() {
        const host = document.getElementById('accountSettings');
        if (!host) return;
        host.innerHTML = `<div class="SettingsCardTitle">Techtoby Account</div>
            <div class="AccountSignedInRow" id="accountSignedInRow" hidden>
                <div id="accountIdentity"></div>
                <div id="accountSignedIn">
                    <button type="button" class="GTextBtn" id="accountUploadPicture">Upload picture</button>
                    <input type="file" id="accountPictureFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
                    <button type="button" class="GTextBtn" id="accountSave">Save now</button>
                    <button type="button" class="GTextBtn" id="accountReload">Reload data</button>
                    <button type="button" class="GTextBtn" id="accountLogout">Log out</button>
                </div>
            </div>
            <p data-account-status role="status" aria-live="polite"></p>
            <form id="accountForm">
                <div class="AccountAuthTabs" role="tablist" aria-label="Account action">
                    <button type="button" class="AccountAuthTab active" id="accountLoginTab" role="tab" aria-selected="true" aria-controls="accountLoginCard">Log in</button>
                    <button type="button" class="AccountAuthTab" id="accountSignupTab" role="tab" aria-selected="false" aria-controls="accountSignupCard">Sign up</button>
                </div>
                <div class="AccountAuthViewport">
                    <div class="AccountAuthTrack" id="accountAuthTrack">
                        <section class="AccountAuthCard" id="accountLoginCard" role="tabpanel" aria-labelledby="accountLoginTab">
                            <p class="SettingsCardDesc">Restore the data saved to your Techtoby account.</p>
                            <div class="AccountAuthCardFields">
                                <div class="form-group AccountUsernameField"><label for="accountLoginUsername">Roblox username</label>
                                    <input id="accountLoginUsername" autocomplete="username" minlength="3" maxlength="20" required aria-describedby="accountLookupStatus" aria-controls="accountSuggestions">
                                    <div id="accountSuggestions"></div>
                                    <div id="accountLookupStatus" role="status" aria-live="polite"></div>
                                </div>
                                <div class="form-group"><label for="accountLoginPassword">Techtoby password</label>
                                    <input id="accountLoginPassword" type="password" autocomplete="current-password" minlength="8" maxlength="128" required>
                                </div>
                            </div>
                            <button class="GTextBtn primary" type="submit" value="login">Log in &amp; restore data</button>
                        </section>
                        <section class="AccountAuthCard" id="accountSignupCard" role="tabpanel" aria-labelledby="accountSignupTab" aria-hidden="true">
                            <p class="SettingsCardDesc">Create an account and save this device’s current app data. Use a separate Techtoby password, never your Roblox password.</p>
                            <div class="AccountAuthCardFields">
                                <div class="form-group"><label for="accountSignupUsername">Exact Roblox username</label>
                                    <input id="accountSignupUsername" autocomplete="username" minlength="3" maxlength="20" required disabled>
                                </div>
                                <div class="form-group"><label for="accountSignupPassword">Create a Techtoby password</label>
                                    <input id="accountSignupPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required disabled>
                                </div>
                            </div>
                            <button class="GTextBtn primary" type="submit" value="register">Create account &amp; save this device</button>
                        </section>
                    </div>
                </div>
            </form>`;
        const current = state();
        const identity = host.querySelector('#accountIdentity');
        identity.textContent = current?.account ? `@${current.account.username}` : '';
        if (current?.account?.pfp) {
            const avatar = document.createElement('img');
            avatar.src = current.account.pfp; avatar.alt = ''; avatar.width = 48; avatar.height = 48;
            identity.prepend(avatar);
        }
        host.querySelector('#accountSignedInRow').hidden = !current?.token;
        host.querySelector('#accountForm').hidden = !!current?.token;
        notify(status);
        const handle = action => async () => { try { await action(); } catch (error) { notify(error.message); } };
        host.querySelector('#accountUploadPicture').onclick = () => host.querySelector('#accountPictureFile').click();
        host.querySelector('#accountPictureFile').onchange = async event => {
            const file = event.target.files[0];
            if (!file) return;
            const button = host.querySelector('#accountUploadPicture');
            button.disabled = true;
            notify('Uploading profile picture…');
            try { await uploadPicture(file); }
            catch (error) { notify(error.message); }
            finally { button.disabled = false; event.target.value = ''; }
        };
        host.querySelector('#accountSave').onclick = handle(sync);
        host.querySelector('#accountReload').onclick = handle(async () => {
            if (confirm('Replace this device’s cached data with the cloud copy? Export any unsaved local changes first.')) await refresh(true);
        });
        host.querySelector('#accountLogout').onclick = handle(logout);
        let searchTimer, searchVersion = 0;
        const loginTab = host.querySelector('#accountLoginTab');
        const signupTab = host.querySelector('#accountSignupTab');
        const track = host.querySelector('#accountAuthTrack');
        const loginFields = [host.querySelector('#accountLoginUsername'), host.querySelector('#accountLoginPassword')];
        const signupFields = [host.querySelector('#accountSignupUsername'), host.querySelector('#accountSignupPassword')];
        const selectCard = action => {
            const signup = action === 'register';
            track.classList.toggle('signup', signup);
            loginTab.classList.toggle('active', !signup); signupTab.classList.toggle('active', signup);
            loginTab.setAttribute('aria-selected', String(!signup)); signupTab.setAttribute('aria-selected', String(signup));
            host.querySelector('#accountLoginCard').setAttribute('aria-hidden', String(signup));
            host.querySelector('#accountSignupCard').setAttribute('aria-hidden', String(!signup));
            loginFields.forEach(field => field.disabled = signup);
            signupFields.forEach(field => field.disabled = !signup);
            if (signup) { ++searchVersion; host.querySelector('#accountSuggestions').classList.remove('open'); }
        };
        loginTab.onclick = () => selectCard('login');
        signupTab.onclick = () => selectCard('register');
        const input = host.querySelector('#accountLoginUsername');
        input.oninput = () => {
            clearTimeout(searchTimer);
            const version = ++searchVersion;
            const suggestions = host.querySelector('#accountSuggestions');
            const message = host.querySelector('#accountLookupStatus');
            suggestions.replaceChildren();
            suggestions.classList.remove('open');
            message.textContent = input.value.trim().length < 3 ? 'Enter at least 3 characters.' : 'Looking up Roblox users…';
            if (input.value.trim().length < 3) return;
            searchTimer = setTimeout(async () => {
                try {
                    const result = await request('search?q=' + encodeURIComponent(input.value.trim()), {}, null);
                    if (version !== searchVersion) return;
                    message.textContent = result.users.length ? '' : 'No Roblox users found.';
                    for (const user of result.users) {
                        const button = document.createElement('button');
                        button.type = 'button'; button.className = 'AccountSuggestion';
                        const display = document.createElement('span'); display.className = 'AccountSuggestionDisplay'; display.textContent = user.displayName || user.username;
                        const username = document.createElement('span'); username.className = 'AccountSuggestionUsername'; username.textContent = `@${user.username}`;
                        button.append(display, username);
                        button.onclick = () => { ++searchVersion; input.value = user.username; suggestions.replaceChildren(); suggestions.classList.remove('open'); message.textContent = `Selected @${user.username}`; };
                        suggestions.append(button);
                    }
                    suggestions.classList.toggle('open', result.users.length > 0);
                } catch (error) { if (version === searchVersion) message.textContent = error.message; }
            }, 350);
        };
        host.querySelector('#accountForm').onsubmit = async event => {
            event.preventDefault();
            const action = event.submitter?.value || 'login';
            if (action === 'login' && Object.keys(snapshot()).length && !confirm('Restore this account’s cloud data on this device? Export any local data you want to keep first.')) return;
            const buttons = host.querySelectorAll('button');
            buttons.forEach(b => b.disabled = true);
            notify(action === 'register' ? 'Creating your account and saving app data…' : 'Logging in and restoring app data…');
            const username = host.querySelector(action === 'login' ? '#accountLoginUsername' : '#accountSignupUsername');
            const password = host.querySelector(action === 'login' ? '#accountLoginPassword' : '#accountSignupPassword');
            try { await authenticate(action, username.value.trim(), password.value); }
            catch (error) { notify(error.message); }
            finally { buttons.forEach(b => b.disabled = false); password.value = ''; selectCard(action); }
        };
    }
    window.TechtobyAccount = { sync, refresh, snapshot, authenticate, logout, uploadPicture, searchRobloxUsers, lookupRobloxUser, bindRobloxAutocomplete, migrateLegacyProfiles, current: () => state()?.account || null };
    document.addEventListener('DOMContentLoaded', mount);
    window.addEventListener('online', () => sync().catch(() => {}));
    window.addEventListener('storage', event => {
        if (event.key === KEY && JSON.parse(event.oldValue || 'null')?.token !== state()?.token) location.reload();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sync().catch(() => {}); });
    window.addEventListener('pagehide', () => {
        const current = state();
        if (current?.token && !same(snapshot(), current.base || {})) sync().catch(() => {});
    });
    setInterval(() => {
        if (!state()?.token || paused) return;
        sync().then(() => refresh()).catch(() => {});
    }, 30000);
    if (state()?.token) refresh().catch(error => { if (error.status === 401) paused = true; notify(error.message); });
})();
