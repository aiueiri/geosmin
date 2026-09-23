/* =========================================================
   Firebase 設定
   ========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyDTwtGtdViDlWVy5xRBlc5tYTFA2xRF3Gk",
  authDomain: "geosmin.firebaseapp.com",
  projectId: "geosmin",
  storageBucket: "geosmin.firebasestorage.app",
  messagingSenderId: "362625396075",
  appId: "1:362625396075:web:3e2c66f1c11395e0bbb02e"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* =========================================================
   定数
   ========================================================= */
const categoryLabels = {asset:"資産", liability:"負債", equity:"資本", revenue:"収益", expense:"費用"};
const categoryOrder = ["asset","liability","equity","revenue","expense"];

const DEFAULT_ACCOUNTS = [
  ["現金","asset"],["普通預金","asset"],["定期預金","asset"],["売掛金","asset"],["前払費用","asset"],
  ["未収入金","asset"],["工具器具備品","asset"],["車両運搬具","asset"],["建物","asset"],["土地","asset"],["事業主貸","asset"],
  ["買掛金","liability"],["未払金","liability"],["未払費用","liability"],["借入金","liability"],["預り金","liability"],
  ["元入金","equity"],["事業主借","equity"],
  ["売上高","revenue"],["雑収入","revenue"],
  ["仕入高","expense"],["租税公課","expense"],["荷造運賃","expense"],["水道光熱費","expense"],["旅費交通費","expense"],
  ["通信費","expense"],["広告宣伝費","expense"],["接待交際費","expense"],["損害保険料","expense"],["修繕費","expense"],
  ["消耗品費","expense"],["減価償却費","expense"],["福利厚生費","expense"],["給料賃金","expense"],["外注工賃","expense"],
  ["利子割引料","expense"],["地代家賃","expense"],["雑費","expense"],["支払手数料","expense"],["会議費","expense"]
];

/* =========================================================
   状態
   ========================================================= */
let currentUser = null;
let accounts = [];      // {id,name,category}
let entries = [];       // {id,date,fiscalYearId,description,debitLines:[{accountId,amount}],creditLines:[{accountId,amount}]}
let fiscalYears = [];   // {id,name,startDate,endDate}
let unsubAccounts = null, unsubEntries = null, unsubYears = null;
let pendingImportRows = [];
let editingEntryId = null;
let migrationChecked = false;
let debitLineSeq = 0, creditLineSeq = 0;

/* =========================================================
   ユーティリティ
   ========================================================= */
function fmt(n){ return Number(n||0).toLocaleString('ja-JP'); }
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function accountName(id){
  const a = accounts.find(x=>x.id===id);
  return a ? a.name : '(削除済み)';
}
function $(id){ return document.getElementById(id); }

/* =========================================================
   認証
   ========================================================= */
function translateAuthError(e){
  const map = {
    'auth/invalid-email':'メールアドレスの形式が正しくありません',
    'auth/user-not-found':'ユーザーが見つかりません',
    'auth/wrong-password':'パスワードが違います',
    'auth/email-already-in-use':'このメールアドレスは既に登録されています',
    'auth/weak-password':'パスワードは6文字以上にしてください',
    'auth/invalid-credential':'メールアドレスまたはパスワードが違います',
    'auth/too-many-requests':'試行回数が多すぎます。しばらく待ってから再試行してください'
  };
  return map[e.code] || e.message;
}

function doLogin(){
  const email = $('loginEmail').value.trim();
  const pass = $('loginPassword').value;
  $('loginError').style.color = "#c0392b";
  $('loginError').textContent = "";
  if(!email || !pass){ $('loginError').textContent = "メールとパスワードを入力してください"; return; }
  auth.signInWithEmailAndPassword(email, pass).catch(e=>{
    $('loginError').textContent = "ログイン失敗: " + translateAuthError(e);
  });
}

function doResetPassword(){
  const email = $('loginEmail').value.trim();
  if(!email){ $('loginError').textContent = "メールアドレスを入力してください"; return; }
  auth.sendPasswordResetEmail(email).then(()=>{
    $('loginError').style.color = "#2f7a5f";
    $('loginError').textContent = "パスワード再設定メールを送信しました";
  }).catch(e=>{
    $('loginError').style.color = "#c0392b";
    $('loginError').textContent = translateAuthError(e);
  });
}

function doLogout(){ auth.signOut(); }

/* =========================================================
   認証状態監視
   ========================================================= */
auth.onAuthStateChanged(user=>{
  if(user){
    currentUser = user;
    $('loginScreen').style.display = 'none';
    $('appScreen').style.display = 'flex';
    $('userEmailLabel').textContent = user.email;
    $('entryDate').valueAsDate = new Date();
    migrationChecked = false;
    startListeners();
  } else {
    currentUser = null;
    if(unsubAccounts) unsubAccounts();
    if(unsubEntries) unsubEntries();
    if(unsubYears) unsubYears();
    accounts = []; entries = []; fiscalYears = [];
    $('loginScreen').style.display = 'flex';
    $('appScreen').style.display = 'none';
  }
});

/* =========================================================
   Firestore
   ========================================================= */
function userDoc(){ return db.collection('users').doc(currentUser.uid); }

async function deleteCollection(name){
  const snap = await userDoc().collection(name).get();
  const docs = snap.docs;
  for(let i=0; i<docs.length; i+=450){
    const batch = db.batch();
    docs.slice(i, i+450).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
}

async function migrateIfNeeded(){
  if(migrationChecked) return;
  migrationChecked = true;

  const accSnap = await userDoc().collection('accounts').get();
  if(accSnap.empty){
    // 初回 → 標準科目を登録
    const batch = db.batch();
    DEFAULT_ACCOUNTS.forEach(([name,category])=>{
      const ref = userDoc().collection('accounts').doc();
      batch.set(ref, {name, category});
    });
    await batch.commit();
    console.log('標準科目を作成しました');
    return;
  }

  // 旧形式・重複チェック
  const nameCount = {};
  accSnap.docs.forEach(d=>{
    const n = d.data().name;
    nameCount[n] = (nameCount[n]||0) + 1;
  });
  const hasDuplicates = Object.values(nameCount).some(c=>c>1);

  const entSnap = await userDoc().collection('entries').get();
  const hasOldEntries = entSnap.docs.some(d=>{
    const data = d.data();
    return data.debitAccount || data.creditAccount;
  });

  if(!hasDuplicates && !hasOldEntries){
    return; // 既に新形式
  }

  const ok = confirm(
    "既存データに旧形式または重複があります。\n\n" +
    "すべての科目・仕訳・会計年度を削除して、クリーンスタートします。\n" +
    "(標準科目は自動で再登録されます)\n\n" +
    "実行してよろしいですか？\n" +
    "※この操作は取り消せません。"
  );
  if(!ok){
    alert('移行をキャンセルしました。旧データはそのまま残ります。');
    return;
  }

  await deleteCollection('accounts');
  await deleteCollection('entries');
  await deleteCollection('fiscalYears');

  const batch = db.batch();
  DEFAULT_ACCOUNTS.forEach(([name,category])=>{
    const ref = userDoc().collection('accounts').doc();
    batch.set(ref, {name, category});
  });
  await batch.commit();
  alert('クリーンスタートが完了しました。標準科目を登録しました。');
}

function startListeners(){
  migrateIfNeeded().catch(e=>{
    console.error(e);
    alert('初期化エラー: ' + e.message);
  });

  unsubAccounts = userDoc().collection('accounts').orderBy('category').orderBy('name')
    .onSnapshot(snap=>{
      accounts = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderAccountSelects();
      renderAccountsTable();
      renderAllLines();
      renderTrialBalance();
      renderPL();
      renderLedger();
    });

  unsubYears = userDoc().collection('fiscalYears').orderBy('name')
    .onSnapshot(snap=>{
      fiscalYears = snap.docs.map(d=>({id:d.id, ...d.data()}));
      populateYearSelects();
      renderYearsTable();
      renderJournal();
      renderLedger();
      renderTrialBalance();
      renderPL();
    });

  unsubEntries = userDoc().collection('entries').orderBy('date')
    .onSnapshot(snap=>{
      entries = snap.docs.map(d=>({id:d.id, ...d.data()}));
      populateYearSelects();
      renderJournal();
      renderLedger();
      renderTrialBalance();
      renderPL();
      renderAccountsTable();
    });

  // 初期行
  if($('debitLines').children.length === 0) addDebitLine();
  if($('creditLines').children.length === 0) addCreditLine();
}

/* =========================================================
   会計年度
   ========================================================= */
function renderYearsTable(){
  const sorted = [...fiscalYears].sort((a,b)=> a.name.localeCompare(b.name));
  let html = '<tr><th class="left">年度名</th><th class="left">開始日</th><th class="left">終了日</th><th>仕訳件数</th><th>操作</th></tr>';
  if(sorted.length===0){
    html += '<tr><td colspan="5" class="empty-msg">会計年度が登録されていません。上のフォームから追加してください。</td></tr>';
  }
  sorted.forEach(y=>{
    const count = entries.filter(e=>e.fiscalYearId===y.id).length;
    html += `<tr>
      <td class="left"><input type="text" value="${escapeHtml(y.name)}" data-action="update-year" data-id="${y.id}" data-field="name" style="width:100%;padding:5px;border:1px solid var(--border);border-radius:4px;"></td>
      <td class="left"><input type="date" value="${y.startDate||''}" data-action="update-year" data-id="${y.id}" data-field="startDate" style="padding:5px;border:1px solid var(--border);border-radius:4px;"></td>
      <td class="left"><input type="date" value="${y.endDate||''}" data-action="update-year" data-id="${y.id}" data-field="endDate" style="padding:5px;border:1px solid var(--border);border-radius:4px;"></td>
      <td>${count}件</td>
      <td>${count>0 ? '<span class="hint">削除不可</span>' : `<button class="btn-danger btn-sm" data-action="delete-year" data-id="${y.id}" data-name="${escapeHtml(y.name)}">削除</button>`}</td>
    </tr>`;
  });
  $('yearsTable').innerHTML = html;
}

function addFiscalYear(){
  const name = $('newYearName').value.trim();
  const startDate = $('newYearStart').value;
  const endDate = $('newYearEnd').value;
  if(!name || !startDate || !endDate){ alert('年度名・開始日・終了日は必須です'); return; }
  if(fiscalYears.some(y=>y.name===name)){ alert('同じ年度名が既に存在します'); return; }
  if(startDate > endDate){ alert('開始日は終了日より前にしてください'); return; }
  userDoc().collection('fiscalYears').add({name, startDate, endDate}).then(()=>{
    $('newYearName').value = '';
    $('newYearStart').value = '';
    $('newYearEnd').value = '';
  });
}

function updateFiscalYear(id, field, value){
  if(field==='name'){
    const other = fiscalYears.find(y=>y.id!==id && y.name===value);
    if(other){ alert('同じ年度名が既に存在します'); renderYearsTable(); return; }
  }
  userDoc().collection('fiscalYears').doc(id).update({[field]: value});
}

function deleteFiscalYear(id, name){
  const count = entries.filter(e=>e.fiscalYearId===id).length;
  if(count>0){
    alert(`「${name}」には${count}件の仕訳が存在するため削除できません。`);
    return;
  }
  if(!confirm(`会計年度「${name}」を削除しますか?`)) return;
  userDoc().collection('fiscalYears').doc(id).delete();
}

/* =========================================================
   科目
   ========================================================= */
function renderAccountSelects(){
  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  const optsHtml = sorted.map(a=>`<option value="${a.id}">[${categoryLabels[a.category]}] ${escapeHtml(a.name)}</option>`).join('');

  document.querySelectorAll('.account-select').forEach(sel=>{
    const prev = sel.value;
    sel.innerHTML = optsHtml;
    if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
  });

  const ledgerSel = $('ledgerAccountSelect');
  if(ledgerSel){
    const prevLedger = ledgerSel.value;
    ledgerSel.innerHTML = optsHtml;
    if([...ledgerSel.options].some(o=>o.value===prevLedger)) ledgerSel.value = prevLedger;
  }
}

function renderAccountsTable(){
  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  let html = '<tr><th class="left">科目名</th><th class="left">区分</th><th>使用状況</th><th>操作</th></tr>';
  if(sorted.length===0){
    html += '<tr><td colspan="4" class="empty-msg">科目がありません</td></tr>';
  }
  sorted.forEach(a=>{
    const used = isAccountUsed(a.id);
    html += `<tr>
      <td class="left"><input type="text" value="${escapeHtml(a.name)}" data-action="update-account" data-id="${a.id}" data-field="name" style="width:100%;padding:5px;border:1px solid var(--border);border-radius:4px;"></td>
      <td class="left">
        <select data-action="update-account" data-id="${a.id}" data-field="category" style="padding:5px;border:1px solid var(--border);border-radius:4px;">
          ${categoryOrder.map(c=>`<option value="${c}" ${c===a.category?'selected':''}>${categoryLabels[c]}</option>`).join('')}
        </select>
      </td>
      <td>${used ? '<span class="cat-badge">使用中</span>' : '<span class="cat-badge">未使用</span>'}</td>
      <td>${used ? '<span class="hint">削除不可</span>' : `<button class="btn-danger btn-sm" data-action="delete-account" data-id="${a.id}" data-name="${escapeHtml(a.name)}">削除</button>`}</td>
    </tr>`;
  });
  $('accountsTable').innerHTML = html;
}

function isAccountUsed(accountId){
  return entries.some(e=>
    (e.debitLines||[]).some(l=>l.accountId===accountId) ||
    (e.creditLines||[]).some(l=>l.accountId===accountId)
  );
}

function updateAccount(id, field, value){
  if(field==='name'){
    const v = value.trim();
    if(!v){ alert('科目名は空にできません'); renderAccountsTable(); return; }
    const dup = accounts.find(a=>a.id!==id && a.name===v);
    if(dup){ alert('同じ名前の科目が既に存在します'); renderAccountsTable(); return; }
    userDoc().collection('accounts').doc(id).update({name:v});
  } else {
    userDoc().collection('accounts').doc(id).update({[field]: value});
  }
}

function deleteAccount(id, name){
  if(isAccountUsed(id)){
    alert(`「${name}」は仕訳で使用されているため削除できません。`);
    return;
  }
  if(!confirm(`科目「${name}」を削除しますか?`)) return;
  userDoc().collection('accounts').doc(id).delete();
}

/* =========================================================
   仕訳入力(複式・複数行)
   ========================================================= */
function makeLineHtml(side, seq){
  return `<div class="line-row" data-side="${side}" data-seq="${seq}">
    <select class="account-select" data-action="recalc"></select>
    <input type="number" class="amount-input" min="0" placeholder="金額" data-action="recalc">
    <button class="line-remove" data-action="remove-line" data-side="${side}" data-seq="${seq}" title="行を削除">×</button>
  </div>`;
}

function addDebitLine(accountId, amount){
  const seq = ++debitLineSeq;
  const wrap = $('debitLines');
  wrap.insertAdjacentHTML('beforeend', makeLineHtml('debit', seq));
  const row = wrap.querySelector(`.line-row[data-seq="${seq}"]`);
  // アカウント選択肢を設定
  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  const optsHtml = sorted.map(a=>`<option value="${a.id}">[${categoryLabels[a.category]}] ${escapeHtml(a.name)}</option>`).join('');
  row.querySelector('.account-select').innerHTML = optsHtml;
  if(accountId) row.querySelector('.account-select').value = accountId;
  if(amount!=null) row.querySelector('.amount-input').value = amount;
  recalcTotals();
}

function addCreditLine(accountId, amount){
  const seq = ++creditLineSeq;
  const wrap = $('creditLines');
  wrap.insertAdjacentHTML('beforeend', makeLineHtml('credit', seq));
  const row = wrap.querySelector(`.line-row[data-seq="${seq}"]`);
  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  const optsHtml = sorted.map(a=>`<option value="${a.id}">[${categoryLabels[a.category]}] ${escapeHtml(a.name)}</option>`).join('');
  row.querySelector('.account-select').innerHTML = optsHtml;
  if(accountId) row.querySelector('.account-select').value = accountId;
  if(amount!=null) row.querySelector('.amount-input').value = amount;
  recalcTotals();
}

function removeLine(side, seq){
  const wrap = side==='debit' ? $('debitLines') : $('creditLines');
  const row = wrap.querySelector(`.line-row[data-seq="${seq}"]`);
  if(!row) return;
  const totalRows = wrap.querySelectorAll('.line-row').length;
  if(totalRows <= 1){ alert('最低1行は必要です'); return; }
  row.remove();
  recalcTotals();
}

function renderAllLines(){
  // 既存行の選択肢を最新に更新(値は保持)
  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  const optsHtml = sorted.map(a=>`<option value="${a.id}">[${categoryLabels[a.category]}] ${escapeHtml(a.name)}</option>`).join('');
  document.querySelectorAll('#debitLines .account-select, #creditLines .account-select').forEach(sel=>{
    const prev = sel.value;
    sel.innerHTML = optsHtml;
    if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
  });
}

function getLines(side){
  const wrap = side==='debit' ? $('debitLines') : $('creditLines');
  const rows = [...wrap.querySelectorAll('.line-row')];
  return rows.map(r=>({
    accountId: r.querySelector('.account-select').value,
    amount: Number(r.querySelector('.amount-input').value) || 0
  })).filter(l=> l.accountId && l.amount > 0);
}

function recalcTotals(){
  const dTotal = getLines('debit').reduce((s,l)=>s+l.amount,0);
  const cTotal = getLines('credit').reduce((s,l)=>s+l.amount,0);
  $('debitTotal').textContent = fmt(dTotal);
  $('creditTotal').textContent = fmt(cTotal);

  const msgEl = $('amountMatchMsg');
  if(dTotal===0 && cTotal===0){
    msgEl.innerHTML = '';
  } else if(dTotal === cTotal && dTotal > 0){
    msgEl.innerHTML = `<span class="amount-match-msg match-ok">✓ 貸借一致 (${fmt(dTotal)} 円)</span>`;
  } else {
    msgEl.innerHTML = `<span class="amount-match-msg match-err">✗ 貸借不一致 (差額: ${fmt(Math.abs(dTotal-cTotal))} 円)</span>`;
  }
}

function submitEntry(){
  const date = $('entryDate').value;
  const desc = $('entryDesc').value.trim();
  const fiscalYearId = $('entryFiscalYear').value;
  const debitLines = getLines('debit');
  const creditLines = getLines('credit');

  if(!date){ alert('日付を入力してください'); return; }
  if(!fiscalYearId){ alert('会計年度を選択してください'); return; }
  if(debitLines.length===0 || creditLines.length===0){ alert('借方・貸方それぞれ1行以上入力してください'); return; }

  const dTotal = debitLines.reduce((s,l)=>s+l.amount,0);
  const cTotal = creditLines.reduce((s,l)=>s+l.amount,0);
  if(dTotal !== cTotal){ alert(`貸借が一致していません(借方 ${fmt(dTotal)} / 貸方 ${fmt(cTotal)})`); return; }

  const fy = fiscalYears.find(y=>y.id===fiscalYearId);
  if(fy && (date < fy.startDate || date > fy.endDate)){
    if(!confirm(`日付(${date})は会計年度「${fy.name}」の期間(${fy.startDate}〜${fy.endDate})外です。登録しますか?`)) return;
  }

  const data = {date, description:desc, fiscalYearId, debitLines, creditLines};

  if(editingEntryId){
    userDoc().collection('entries').doc(editingEntryId).update(data).then(()=>{
      cancelEdit();
      alert('仕訳を更新しました');
    });
  } else {
    userDoc().collection('entries').add(data).then(()=>{
      $('entryDesc').value = '';
      $('debitLines').innerHTML = '';
      $('creditLines').innerHTML = '';
      debitLineSeq = 0; creditLineSeq = 0;
      addDebitLine();
      addCreditLine();
      recalcTotals();
    });
  }
}

function cancelEdit(){
  editingEntryId = null;
  $('entryFormTitle').textContent = '仕訳を入力';
  $('entrySubmitBtn').textContent = '仕訳を登録';
  $('entryCancelBtn').classList.add('hidden');
  $('entryDesc').value = '';
  $('debitLines').innerHTML = '';
  $('creditLines').innerHTML = '';
  debitLineSeq = 0; creditLineSeq = 0;
  addDebitLine();
  addCreditLine();
  recalcTotals();
}

function editEntry(id){
  const e = entries.find(x=>x.id===id);
  if(!e) return;
  editingEntryId = id;
  $('entryFormTitle').innerHTML = '仕訳を編集 <span class="edit-badge">編集中</span>';
  $('entrySubmitBtn').textContent = '変更を保存';
  $('entryCancelBtn').classList.remove('hidden');
  $('entryDate').value = e.date;
  $('entryDesc').value = e.description || '';
  if(e.fiscalYearId) $('entryFiscalYear').value = e.fiscalYearId;

  $('debitLines').innerHTML = '';
  $('creditLines').innerHTML = '';
  debitLineSeq = 0; creditLineSeq = 0;
  (e.debitLines||[]).forEach(l=> addDebitLine(l.accountId, l.amount));
  (e.creditLines||[]).forEach(l=> addCreditLine(l.accountId, l.amount));
  if((e.debitLines||[]).length===0) addDebitLine();
  if((e.creditLines||[]).length===0) addCreditLine();
  recalcTotals();

  switchTab('tab-entry');
  window.scrollTo({top:0, behavior:'smooth'});
}

function duplicateEntry(id){
  const e = entries.find(x=>x.id===id);
  if(!e) return;
  editingEntryId = null;
  $('entryFormTitle').textContent = '仕訳を入力(複製)';
  $('entrySubmitBtn').textContent = '仕訳を登録';
  $('entryCancelBtn').classList.add('hidden');
  $('entryDate').value = e.date;
  $('entryDesc').value = e.description || '';
  if(e.fiscalYearId) $('entryFiscalYear').value = e.fiscalYearId;

  $('debitLines').innerHTML = '';
  $('creditLines').innerHTML = '';
  debitLineSeq = 0; creditLineSeq = 0;
  (e.debitLines||[]).forEach(l=> addDebitLine(l.accountId, l.amount));
  (e.creditLines||[]).forEach(l=> addCreditLine(l.accountId, l.amount));
  recalcTotals();

  switchTab('tab-entry');
  window.scrollTo({top:0, behavior:'smooth'});
}

function deleteEntry(id){
  if(!confirm('この仕訳を削除しますか?')) return;
  userDoc().collection('entries').doc(id).delete();
}

/* =========================================================
   Excel取り込み
   ========================================================= */
function parseDateFlexible(str){
  str = (str||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  let m = str.match(/^(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?$/);
  if(m){ return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`; }
  const d = new Date(str);
  if(!isNaN(d.getTime())){
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  return null;
}

function previewPaste(){
  const raw = $('pasteArea').value;
  const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
  const accountByName = {};
  accounts.forEach(a=> accountByName[a.name] = a);
  const fiscalYearId = $('importFiscalYear').value;

  pendingImportRows = [];
  let html = '<div class="table-wrap"><table><tr><th class="left">日付</th><th class="left">借方科目</th><th>借方金額</th><th class="left">貸方科目</th><th>貸方金額</th><th class="left">摘要</th><th>状態</th></tr>';

  lines.forEach(line=>{
    const cols = line.includes('\t') ? line.split('\t') : line.split(',');
    const [dateRaw, debitAcc, debitAmt, creditAcc, creditAmt, desc] = cols.map(c=>(c||'').trim());
    const date = parseDateFlexible(dateRaw);
    const dAcc = accountByName[debitAcc];
    const cAcc = accountByName[creditAcc];
    const dAmt = Number(debitAmt);
    const cAmt = Number(creditAmt);

    const errors = [];
    if(!date) errors.push('日付不正');
    if(!dAcc) errors.push('借方科目未登録');
    if(!cAcc) errors.push('貸方科目未登録');
    if(!dAmt) errors.push('借方金額不正');
    if(!cAmt) errors.push('貸方金額不正');
    if(dAmt && cAmt && dAmt !== cAmt) errors.push('貸借不一致');

    const ok = errors.length===0;
    if(ok){
      pendingImportRows.push({
        date, description:desc||'', fiscalYearId,
        debitLines:  [{accountId:dAcc.id, amount:dAmt}],
        creditLines: [{accountId:cAcc.id, amount:cAmt}]
      });
    }
    html += `<tr class="${ok?'row-ok':'row-error'}">
      <td class="left">${escapeHtml(dateRaw)}</td>
      <td class="left">${escapeHtml(debitAcc)}</td>
      <td>${escapeHtml(debitAmt)}</td>
      <td class="left">${escapeHtml(creditAcc)}</td>
      <td>${escapeHtml(creditAmt)}</td>
      <td class="left">${escapeHtml(desc||'')}</td>
      <td class="${ok?'status-ok':'status-err'}">${ok?'OK':errors.join('・')}</td>
    </tr>`;
  });
  html += '</table></div>';

  if(lines.length===0){
    html = '<p class="empty-msg">貼り付け欄が空です</p>';
  } else {
    html += `<div style="margin-top:12px;">
      <button class="btn-primary" id="btnConfirmImport">OKの行(${pendingImportRows.length}件)を登録する</button>
    </div>`;
  }
  $('pastePreviewArea').innerHTML = html;
  const btn = $('btnConfirmImport');
  if(btn) btn.addEventListener('click', confirmPasteImport);
}

function confirmPasteImport(){
  if(pendingImportRows.length===0){ alert('登録できる行がありません'); return; }
  const batch = db.batch();
  pendingImportRows.forEach(row=>{
    const ref = userDoc().collection('entries').doc();
    batch.set(ref, row);
  });
  batch.commit().then(()=>{
    alert(`${pendingImportRows.length}件の仕訳を登録しました`);
    $('pasteArea').value = '';
    $('pastePreviewArea').innerHTML = '';
    pendingImportRows = [];
  });
}

/* =========================================================
   Excel出力
   ========================================================= */
function buildExportText(){
  const fyId = $('exportYearSelect').value;
  const rows = entries.filter(e=> fyId==='all' || e.fiscalYearId===fyId);
  let text = '';
  rows.forEach(e=>{
    const debit = (e.debitLines||[]).map(l=>`${accountName(l.accountId)}:${l.amount}`).join(' / ');
    const credit = (e.creditLines||[]).map(l=>`${accountName(l.accountId)}:${l.amount}`).join(' / ');
    text += `${e.date}\t${debit}\t\t${credit}\t\t${e.description||''}\n`;
  });
  $('exportArea').value = text;
}

function downloadCSV(){
  const fyId = $('exportYearSelect').value;
  const rows = entries.filter(e=> fyId==='all' || e.fiscalYearId===fyId);
  let lines = ['"日付","借方科目","借方金額","貸方科目","貸方金額","摘要"'];
  rows.forEach(e=>{
    const maxLen = Math.max((e.debitLines||[]).length, (e.creditLines||[]).length);
    for(let i=0; i<maxLen; i++){
      const dl = (e.debitLines||[])[i] || {accountId:'', amount:''};
      const cl = (e.creditLines||[])[i] || {accountId:'', amount:''};
      lines.push([e.date, accountName(dl.accountId), dl.amount, accountName(cl.accountId), cl.amount, e.description||'']
        .map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
    }
  });
  const blob = new Blob(["\uFEFF"+lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '仕訳データ.csv';
  a.click();
}

/* =========================================================
   年度セレクト
   ========================================================= */
function populateYearSelects(){
  const sorted = [...fiscalYears].sort((a,b)=> a.name.localeCompare(b.name));

  [ $('entryFiscalYear'), $('importFiscalYear') ].forEach(sel=>{
    const prev = sel.value;
    sel.innerHTML = sorted.map(y=>`<option value="${y.id}">${escapeHtml(y.name)} (${y.startDate}〜${y.endDate})</option>`).join('');
    if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
  });

  ['journalYearSelect','ledgerYearSelect','trialYearSelect','exportYearSelect'].forEach(id=>{
    const el = $(id);
    if(!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="all">全期間</option>' +
      sorted.map(y=>`<option value="${y.id}">${escapeHtml(y.name)}</option>`).join('');
    if([...el.options].some(o=>o.value===prev)) el.value = prev;
  });

  const plSel = $('plYearSelect');
  if(plSel){
    const prev = plSel.value;
    plSel.innerHTML = sorted.map(y=>`<option value="${y.id}">${escapeHtml(y.name)}</option>`).join('');
    if([...plSel.options].some(o=>o.value===prev)) plSel.value = prev;
    else if(sorted.length>0) plSel.value = sorted[sorted.length-1].id;
  }

  // デフォルト年度
  const entrySel = $('entryFiscalYear');
  if(!entrySel.value && sorted.length>0){
    const today = new Date().toISOString().slice(0,10);
    const cur = sorted.find(y=> y.startDate <= today && today <= y.endDate);
    const chosen = cur || sorted[sorted.length-1];
    entrySel.value = chosen.id;
    $('importFiscalYear').value = chosen.id;
  }
}

/* =========================================================
   仕訳帳
   ========================================================= */
function renderJournal(){
  const yearSel = $('journalYearSelect');
  if(!yearSel) return;
  const fyId = yearSel.value || 'all';
  const rows = entries.filter(e=> fyId==='all' || e.fiscalYearId===fyId)
    .sort((a,b)=>a.date.localeCompare(b.date));

  let html = '<tr><th class="left">日付</th><th class="left">摘要</th><th class="left">借方</th><th>借方金額</th><th class="left">貸方</th><th>貸方金額</th><th>操作</th></tr>';
  if(rows.length===0){
    html += '<tr><td colspan="7" class="empty-msg">該当する仕訳がありません</td></tr>';
  }
  rows.forEach(e=>{
    const debitStr = (e.debitLines||[]).map(l=>escapeHtml(accountName(l.accountId))).join('<br>');
    const creditStr = (e.creditLines||[]).map(l=>escapeHtml(accountName(l.accountId))).join('<br>');
    const debitAmtStr = (e.debitLines||[]).map(l=>fmt(l.amount)).join('<br>');
    const creditAmtStr = (e.creditLines||[]).map(l=>fmt(l.amount)).join('<br>');
    html += `<tr>
      <td class="left">${e.date}</td>
      <td class="left">${escapeHtml(e.description||'')}</td>
      <td class="left sub-lines">${debitStr}</td>
      <td>${debitAmtStr}</td>
      <td class="left sub-lines">${creditStr}</td>
      <td>${creditAmtStr}</td>
      <td>
        <div class="action-group">
          <button class="btn-outline btn-sm" data-action="edit-entry" data-id="${e.id}">編集</button>
          <button class="btn-outline btn-sm" data-action="dup-entry" data-id="${e.id}">複製</button>
          <button class="btn-danger btn-sm" data-action="delete-entry" data-id="${e.id}">削除</button>
        </div>
      </td>
    </tr>`;
  });
  $('journalTable').innerHTML = html;
}

/* =========================================================
   総勘定元帳
   ========================================================= */
function renderLedger(){
  const accSel = $('ledgerAccountSelect');
  const yearSel = $('ledgerYearSelect');
  if(!accSel || !yearSel) return;
  const accId = accSel.value;
  const fyId = yearSel.value || 'all';
  if(!accId){ $('ledgerTable').innerHTML = '<tr><td class="empty-msg">科目を選択してください</td></tr>'; return; }
  const acc = accounts.find(a=>a.id===accId);
  if(!acc){ $('ledgerTable').innerHTML = '<tr><td class="empty-msg">科目が不明です</td></tr>'; return; }
  const isDebitNormal = (acc.category==='asset' || acc.category==='expense');

  const filtered = entries
    .filter(e=> fyId==='all' || e.fiscalYearId===fyId)
    .filter(e=>
      (e.debitLines||[]).some(l=>l.accountId===accId) ||
      (e.creditLines||[]).some(l=>l.accountId===accId)
    )
    .sort((a,b)=>a.date.localeCompare(b.date));

  let balance = 0;
  let html = '<tr><th class="left">日付</th><th class="left">摘要</th><th class="left">相手科目</th><th>借方</th><th>貸方</th><th>残高</th></tr>';
  if(filtered.length===0){
    html += '<tr><td colspan="6" class="empty-msg">該当する記帳がありません</td></tr>';
  }
  filtered.forEach(e=>{
    const dLines = (e.debitLines||[]).filter(l=>l.accountId===accId);
    const cLines = (e.creditLines||[]).filter(l=>l.accountId===accId);
    const debitVal = dLines.reduce((s,l)=>s+l.amount,0);
    const creditVal = cLines.reduce((s,l)=>s+l.amount,0);
    balance += isDebitNormal ? (debitVal - creditVal) : (creditVal - debitVal);

    const counter = dLines.length>0
      ? (e.creditLines||[]).map(l=>accountName(l.accountId)).join(' / ')
      : (e.debitLines||[]).map(l=>accountName(l.accountId)).join(' / ');

    html += `<tr>
      <td class="left">${e.date}</td>
      <td class="left">${escapeHtml(e.description||'')}</td>
      <td class="left">${escapeHtml(counter)}</td>
      <td>${debitVal?fmt(debitVal):''}</td>
      <td>${creditVal?fmt(creditVal):''}</td>
      <td>${fmt(balance)}</td>
    </tr>`;
  });
  $('ledgerTable').innerHTML = html;
}

/* =========================================================
   試算表
   ========================================================= */
function renderTrialBalance(){
  const yearSel = $('trialYearSelect');
  if(!yearSel) return;
  const fyId = yearSel.value || 'all';
  const filtered = entries.filter(e=> fyId==='all' || e.fiscalYearId===fyId);

  const sorted = [...accounts].sort((a,b)=> categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category) || a.name.localeCompare(b.name,'ja'));
  let html = '<tr><th class="left">科目</th><th class="left">区分</th><th>借方合計</th><th>貸方合計</th><th>借方残高</th><th>貸方残高</th></tr>';
  let sumDebitTotal=0, sumCreditTotal=0, sumDebitBal=0, sumCreditBal=0;

  sorted.forEach(a=>{
    const debitTotal = filtered.reduce((s,e)=> s + (e.debitLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    const creditTotal = filtered.reduce((s,e)=> s + (e.creditLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    if(debitTotal===0 && creditTotal===0) return;
    const isDebitNormal = (a.category==='asset' || a.category==='expense');
    const net = debitTotal - creditTotal;
    const debitBal = isDebitNormal ? Math.max(net,0) : Math.max(-net,0);
    const creditBal = isDebitNormal ? Math.max(-net,0) : Math.max(net,0);
    sumDebitTotal+=debitTotal; sumCreditTotal+=creditTotal; sumDebitBal+=debitBal; sumCreditBal+=creditBal;
    html += `<tr>
      <td class="left">${escapeHtml(a.name)}</td>
      <td class="left"><span class="cat-badge">${categoryLabels[a.category]}</span></td>
      <td>${debitTotal?fmt(debitTotal):''}</td>
      <td>${creditTotal?fmt(creditTotal):''}</td>
      <td>${debitBal?fmt(debitBal):''}</td>
      <td>${creditBal?fmt(creditBal):''}</td>
    </tr>`;
  });
  html += `<tr class="total-row"><td class="left" colspan="2">合計</td><td>${fmt(sumDebitTotal)}</td><td>${fmt(sumCreditTotal)}</td><td>${fmt(sumDebitBal)}</td><td>${fmt(sumCreditBal)}</td></tr>`;
  $('trialTable').innerHTML = html;

  const checkEl = $('trialBalanceCheck');
  const totalOk = (sumDebitTotal === sumCreditTotal);
  const balOk = (sumDebitBal === sumCreditBal);
  if(totalOk && balOk){
    checkEl.innerHTML = `<div class="balance-check balance-ok">✓ 貸借一致 (合計 ${fmt(sumDebitTotal)} 円 / 残高 ${fmt(sumDebitBal)} 円)</div>`;
  } else {
    let msg = '✗ 貸借不一致 ';
    if(!totalOk) msg += `[合計 差額 ${fmt(Math.abs(sumDebitTotal-sumCreditTotal))}円] `;
    if(!balOk) msg += `[残高 差額 ${fmt(Math.abs(sumDebitBal-sumCreditBal))}円]`;
    checkEl.innerHTML = `<div class="balance-check balance-err">${msg}</div>`;
  }
}

/* =========================================================
   損益計算書
   ========================================================= */
function renderPL(){
  const yearSel = $('plYearSelect');
  if(!yearSel) return;
  const fyId = yearSel.value;
  if(!fyId){ $('plTable').innerHTML = '<tr><td class="empty-msg">会計年度を選択してください</td></tr>'; return; }
  const filtered = entries.filter(e=> e.fiscalYearId===fyId);

  const revenueAccs = accounts.filter(a=>a.category==='revenue').sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  const expenseAccs = accounts.filter(a=>a.category==='expense').sort((a,b)=>a.name.localeCompare(b.name,'ja'));

  let html = '<tr><th class="left">科目</th><th>金額</th></tr>';
  let revenueTotal = 0;
  html += '<tr class="pl-section-header"><td colspan="2" class="left">収益の部</td></tr>';
  revenueAccs.forEach(a=>{
    const credit = filtered.reduce((s,e)=> s + (e.creditLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    const debit  = filtered.reduce((s,e)=> s + (e.debitLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    const val = credit - debit;
    if(val===0) return;
    revenueTotal += val;
    html += `<tr><td class="left">${escapeHtml(a.name)}</td><td>${fmt(val)}</td></tr>`;
  });
  html += `<tr class="total-row"><td class="left">収益合計</td><td>${fmt(revenueTotal)}</td></tr>`;

  let expenseTotal = 0;
  html += '<tr class="pl-section-header"><td colspan="2" class="left">費用の部</td></tr>';
  expenseAccs.forEach(a=>{
    const debit  = filtered.reduce((s,e)=> s + (e.debitLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    const credit = filtered.reduce((s,e)=> s + (e.creditLines||[]).filter(l=>l.accountId===a.id).reduce((x,l)=>x+l.amount,0), 0);
    const val = debit - credit;
    if(val===0) return;
    expenseTotal += val;
    html += `<tr><td class="left">${escapeHtml(a.name)}</td><td>${fmt(val)}</td></tr>`;
  });
  html += `<tr class="total-row"><td class="left">費用合計</td><td>${fmt(expenseTotal)}</td></tr>`;
  html += `<tr class="pl-final"><td class="left">当期純利益(収益-費用)</td><td>${fmt(revenueTotal-expenseTotal)}</td></tr>`;

  $('plTable').innerHTML = html;
}

/* =========================================================
   タブ
   ========================================================= */
function switchTab(tabId){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  const panel = $(tabId);
  if(panel) panel.classList.add('active');
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if(btn) btn.classList.add('active');
}

/* =========================================================
   イベント登録(インラインonclickを使わない)
   ========================================================= */
document.addEventListener('DOMContentLoaded', ()=>{

  // ログイン画面
  $('btnLogin').addEventListener('click', doLogin);
  $('btnReset').addEventListener('click', doResetPassword);
  $('loginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

  // ログアウト
  $('btnLogout').addEventListener('click', doLogout);

  // タブ
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTab(btn.dataset.tab));
  });

  // 仕訳入力
  $('btnAddDebit').addEventListener('click', ()=> addDebitLine());
  $('btnAddCredit').addEventListener('click', ()=> addCreditLine());
  $('entrySubmitBtn').addEventListener('click', submitEntry);
  $('entryCancelBtn').addEventListener('click', cancelEdit);
  $('entryFiscalYear').addEventListener('change', ()=>{
    const fyId = $('entryFiscalYear').value;
    const fy = fiscalYears.find(y=>y.id===fyId);
    if(fy){
      const today = new Date().toISOString().slice(0,10);
      $('entryDate').value = (today >= fy.startDate && today <= fy.endDate) ? today : fy.startDate;
    }
  });

  // 借方/貸方の動的イベント(delegation)
  document.addEventListener('input', e=>{
    if(e.target.matches('#debitLines .amount-input, #creditLines .amount-input, #debitLines .account-select, #creditLines .account-select')){
      recalcTotals();
    }
  });
  document.addEventListener('click', e=>{
    const t = e.target.closest('[data-action="remove-line"]');
    if(t){ removeLine(t.dataset.side, Number(t.dataset.seq)); }
  });

  // Excel取り込み
  $('btnPreviewPaste').addEventListener('click', previewPaste);
  $('btnBuildExport').addEventListener('click', buildExportText);
  $('btnDownloadCSV').addEventListener('click', downloadCSV);

  // 年度セレクトのchange
  ['journalYearSelect','ledgerYearSelect','trialYearSelect','plYearSelect'].forEach(id=>{
    const el = $(id);
    if(!el) return;
    el.addEventListener('change', ()=>{
      if(id==='journalYearSelect') renderJournal();
      else if(id==='ledgerYearSelect') renderLedger();
      else if(id==='trialYearSelect') renderTrialBalance();
      else if(id==='plYearSelect') renderPL();
    });
  });
  $('ledgerAccountSelect').addEventListener('change', renderLedger);

  // 会計年度追加
  $('btnAddYear').addEventListener('click', addFiscalYear);

  // テーブル内の動的ボタン(委譲)
  document.addEventListener('click', e=>{
    const t = e.target.closest('[data-action]');
    if(!t) return;
    const action = t.dataset.action;
    const id = t.dataset.id;
    if(action==='edit-entry') editEntry(id);
    else if(action==='dup-entry') duplicateEntry(id);
    else if(action==='delete-entry') deleteEntry(id);
    else if(action==='delete-year') deleteFiscalYear(id, t.dataset.name);
    else if(action==='delete-account') deleteAccount(id, t.dataset.name);
  });

  // テーブル内の動的input/selectの変更(委譲)
  document.addEventListener('change', e=>{
    const t = e.target.closest('[data-action="update-year"]');
    if(t){ updateFiscalYear(t.dataset.id, t.dataset.field, t.value); return; }
    const a = e.target.closest('[data-action="update-account"]');
    if(a){ updateAccount(a.dataset.id, a.dataset.field, a.value); return; }
  });

  // 初期行(ログイン前でも要素自体は存在する)
  if($('debitLines') && $('debitLines').children.length === 0) addDebitLine();
  if($('creditLines') && $('creditLines').children.length === 0) addCreditLine();
});
