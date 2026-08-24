/* ===================================================================
   Meu Treino — app standalone (Firebase Auth + Firestore, offline-first)
   =================================================================== */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// habilita cache offline (o navegador guarda os dados e sincroniza
// automaticamente quando a internet voltar)
db.enablePersistence({ synchronizeTabs: true }).catch(() => {
  // se falhar (ex.: várias abas abertas em navegadores antigos), o app
  // ainda funciona normalmente, só perde o cache offline
});

const uid = () => Math.random().toString(36).slice(2, 10);

const el = (id) => document.getElementById(id);
const appEl = document.getElementById("app");

let currentUser = null; // objeto do Firebase Auth
let isTrainer = false;
let clients = []; // só preenchido para o treinador
let myClient = null; // só preenchido para o aluno
let unsubscribe = null;

let ui = { view: "loading", selectedId: null, activeDayId: null, progOpen: false, progMode: "table", progKey: null, studentEnteredTreinos: false };
let draggedDayId = null;
let collapsedEx = {}; // exercícios minimizados; por padrão, todo exercício começa minimizado
const isCollapsed = (exId) => collapsedEx[exId] !== false;

// ---------- autenticação ----------

auth.onAuthStateChanged((user) => {
  currentUser = user;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    ui = { view: "gate", mode: "login", error: "" };
    render();
    return;
  }

  isTrainer = user.email.toLowerCase() === TRAINER_EMAIL.toLowerCase();

  if (isTrainer) {
    ui = { view: "trainer", selectedId: null, activeDayId: null };
    unsubscribe = db.collection("clients").onSnapshot((snap) => {
      clients = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    });
  } else {
    ui = { view: "student", activeDayId: null };
    unsubscribe = db
      .collection("clients")
      .where("email", "==", user.email.toLowerCase())
      .onSnapshot((snap) => {
        myClient = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
        render();
      });
  }
  render();
});

function doLogin(email, password) {
  auth.signInWithEmailAndPassword(email, password).catch((e) => {
    ui.error = traduzErro(e.code);
    render();
  });
}

function doLogout() {
  ui.studentEnteredTreinos = false;
  auth.signOut();
}

function traduzErro(code) {
  if (code === "auth/invalid-email") return "Email inválido";
  if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential")
    return "Email ou senha incorretos";
  if (code === "auth/too-many-requests") return "Muitas tentativas. Tente de novo em instantes.";
  if (code === "auth/email-already-in-use") return "Esse email já tem uma conta";
  if (code === "auth/weak-password") return "Senha muito curta (mínimo 6 caracteres)";
  return "Erro: " + code;
}

// ---------- treinador: criar aluno (conta + ficha) ----------
// usa uma instância secundária do Firebase para criar a conta do aluno
// sem derrubar a sessão do treinador
async function createStudent(name, email, password, copyDaysFrom) {
  const secondary = firebase.apps.find((a) => a.name === "Secondary") || firebase.initializeApp(firebaseConfig, "Secondary");
  const secAuth = secondary.auth();
  const cred = await secAuth.createUserWithEmailAndPassword(email.toLowerCase(), password);
  await secAuth.signOut();

  const days = copyDaysFrom ? cloneDaysWithNewIds(copyDaysFrom) : [];

  await db.collection("clients").doc(cred.user.uid).set({
    name,
    email: email.toLowerCase(),
    password, // guardado só pra você conseguir consultar/copiar depois; só você (e o próprio aluno) enxergam isso
    goal: "",
    days,
    createdAt: Date.now(),
  });
}

// clona os dias de treino de outro aluno, gerando ids novos pra tudo
// (dias, exercícios e séries), sem carregar nenhum histórico/progresso junto
function cloneDaysWithNewIds(days) {
  return (days || []).map((d) => ({
    ...d,
    id: uid(),
    exercises: (d.exercises || []).map((ex) => ({
      ...ex,
      id: uid(),
      sets: (ex.sets || []).map((s) => ({ ...s, id: uid(), repsDone: "" })),
    })),
  }));
}

async function removeStudentDoc(clientId) {
  // remove só a ficha de treino (não a conta de login — isso exige o
  // Admin SDK, fora do alcance do app do navegador)
  await db.collection("clients").doc(clientId).delete();
}

async function recordClientPassword(clientId, password) {
  // isso só REGISTRA a senha pra ela aparecer na tela — não altera a senha
  // de login de verdade (isso precisa ser feito no Console do Firebase)
  await db.collection("clients").doc(clientId).update({ password });
}

// ---------- leitura/escrita dos dados de treino ----------

function saveClient(id, patch) {
  db.collection("clients").doc(id).update(patch).catch((e) => alert("Erro ao salvar: " + e.message));
}

function emptySet() { return { id: uid(), repsGoal: "10", repsDone: "", load: "", intensity: 0, rir: "", rirEnabled: false }; }
function emptyExercise() { return { id: uid(), name: "", notes: "", sets: [emptySet()] }; }

function emptyDay(title) { return { id: uid(), title, exercises: [] }; }

function updateDays(client, nextDays) {
  saveClient(client.id, { days: nextDays });
}

// ---------- render ----------

function render() {
  appEl.innerHTML = "";
  if (ui.view === "loading") { appEl.innerHTML = loadingHTML(); return; }
  if (ui.view === "gate") { appEl.innerHTML = gateHTML(); wireGate(); return; }
  if (ui.view === "trainer") { appEl.innerHTML = trainerHTML(); wireTrainer(); return; }
  if (ui.view === "student") {
    appEl.innerHTML = studentHTML();
    el("btn-logout").onclick = doLogout;
    if (myClient && !ui.studentEnteredTreinos) {
      const enterBtn = el("enter-treinos");
      if (enterBtn) enterBtn.onclick = () => { ui.studentEnteredTreinos = true; render(); };
    } else {
      wireClientArea(myClient, false);
    }
    return;
  }
}

function loadingHTML() {
  return `<p style="text-align:center;color:var(--muted);padding-top:60px;">Carregando…</p>`;
}

function gateHTML() {
  return `
    <div class="gate">
      <div class="display" style="font-size:26px;">MEU TREINO</div>
      <p class="muted-note">Entre com o email e a senha que seu personal te enviou.</p>
      <input id="g-email" type="email" placeholder="Email" autocomplete="username" />
      <input id="g-pass" type="password" placeholder="Senha" autocomplete="current-password" />
      ${ui.error ? `<div class="error">${ui.error}</div>` : ""}
      <button class="primary" id="g-submit">ENTRAR</button>
    </div>`;
}

function wireGate() {
  const submit = () => {
    const email = el("g-email").value.trim();
    const pass = el("g-pass").value;
    ui.error = "";
    doLogin(email, pass);
  };
  el("g-submit").onclick = submit;
  el("g-pass").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function topbarHTML(name, extraBadge) {
  return `
    <div class="topbar">
      <div class="display name">${escapeHTML(name)}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${extraBadge ? `<span class="badge">${extraBadge}</span>` : ""}
        <button class="logout" id="btn-logout">Sair</button>
      </div>
    </div>`;
}

// ---------------- TREINADOR ----------------

function trainerHTML() {
  const selected = clients.find((c) => c.id === ui.selectedId) || null;
  return `
    ${topbarHTML("Personal", "modo treinador")}
    <div class="layout">
      <div class="sidebar">
        <h1 class="display">ALUNOS</h1>
        <button class="dashed-btn" id="btn-add-client" style="width:100%;justify-content:center;margin-bottom:10px;">+ novo aluno</button>
        <div id="add-client-form" class="hidden" style="display:flex;flex-direction:column;gap:6px;background:var(--panelAlt);padding:8px;border-radius:8px;margin-bottom:10px;">
          <input id="nc-name" placeholder="Nome do aluno" />
          <input id="nc-email" type="email" placeholder="Email do aluno" />
          <input id="nc-pass" placeholder="Senha (mín. 6 caracteres)" />
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button id="nc-cancel" style="color:var(--muted);font-size:12px;">cancelar</button>
            <button id="nc-save" style="color:var(--plate);font-size:12px;">salvar</button>
          </div>
        </div>
        <div id="nc-error" class="error" style="font-size:12px;"></div>
        <div style="display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;">
          ${clients.length === 0 ? `<p class="muted-note">Nenhum aluno ainda.</p>` : ""}
          ${clients
            .map((c) => {
              const isSelected = c.id === ui.selectedId;
              return `
            <div class="client-row ${isSelected ? "active" : ""}" data-id="${c.id}">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="cn" style="flex:1;">${escapeHTML(c.name)}</span>
                <button class="copy-btn" data-copy="${c.id}">copiar login</button>
              </div>
              <span class="ce">${escapeHTML(c.email)}</span>
              ${
                isSelected
                  ? `<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
                      <span style="font-size:11px;color:var(--plate);">senha:</span>
                      <input class="ce pw-input" data-pwinput="${c.id}" value="${attr(c.password || "")}" placeholder="não registrada" style="flex:1;color:var(--plate);" />
                      <button class="copy-btn" data-pwsave="${c.id}">salvar</button>
                    </div>`
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>
      </div>
      <div class="main">
        ${selected ? clientAreaHTML(selected, true) : `<p class="muted-note" style="text-align:center;padding:60px 0;">Selecione ou adicione um aluno.</p>`}
      </div>
    </div>`;
}

function wireTrainer() {
  el("btn-logout").onclick = doLogout;
  el("btn-add-client").onclick = () => { el("add-client-form").classList.remove("hidden"); };
  el("nc-cancel").onclick = () => { el("add-client-form").classList.add("hidden"); };
  el("nc-save").onclick = async () => {
    const name = el("nc-name").value.trim();
    const email = el("nc-email").value.trim();
    const pass = el("nc-pass").value;
    el("nc-error").textContent = "";
    if (!name || !email || pass.length < 6) {
      el("nc-error").textContent = "Preencha nome, email e uma senha com 6+ caracteres.";
      return;
    }
    try {
      await createStudent(name, email, pass);
      el("nc-name").value = ""; el("nc-email").value = ""; el("nc-pass").value = "";
      el("add-client-form").classList.add("hidden");
    } catch (e) {
      el("nc-error").textContent = traduzErro(e.code);
    }
  };

  document.querySelectorAll(".client-row").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest(".copy-btn")) return;
      ui.selectedId = row.dataset.id;
      ui.activeDayId = null;
      render();
    };
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const c = clients.find((x) => x.id === btn.dataset.copy);
      const senhaTexto = c.password ? `Senha: ${c.password}` : "(a senha é a que você cadastrou ao criar o aluno)";
      navigator.clipboard.writeText(`Email: ${c.email}\n${senhaTexto}`).catch(() => {});
      btn.textContent = "copiado!";
      setTimeout(() => (btn.textContent = "copiar login"), 1200);
    };
  });

  document.querySelectorAll("[data-pwinput]").forEach((input) => {
    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => e.stopPropagation();
  });

  document.querySelectorAll("[data-pwsave]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const clientId = btn.dataset.pwsave;
      const input = document.querySelector(`[data-pwinput="${clientId}"]`);
      const value = input.value.trim();
      if (!value) return;
      btn.textContent = "…";
      try {
        await recordClientPassword(clientId, value);
        btn.textContent = "salvo!";
        setTimeout(() => (btn.textContent = "salvar"), 1200);
      } catch (err) {
        btn.textContent = "erro";
        setTimeout(() => (btn.textContent = "salvar"), 1500);
      }
    };
  });

  const selected = clients.find((c) => c.id === ui.selectedId);
  if (selected) wireClientArea(selected, true);
}

// ---------------- ALUNO ----------------

function studentHTML() {
  if (myClient && !ui.studentEnteredTreinos) {
    return `
      ${topbarHTML(myClient.name, "modo aluno")}
      <div class="main solo" style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:340px; gap:6px; text-align:center;">
        <i class="ti ti-barbell" style="color:var(--red); font-size:34px;"></i>
        <div class="display" style="font-size:22px; margin-top:6px;">Olá, ${escapeHTML(myClient.name.split(" ")[0])}</div>
        <div class="muted-note" style="margin-bottom:22px;">Bora treinar hoje?</div>
        <button id="enter-treinos" class="cta" style="width:220px; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="ti ti-list-check"></i> Treinos
        </button>
      </div>`;
  }
  return `
    ${topbarHTML(myClient ? myClient.name : "Meu treino", "modo aluno")}
    <div class="main solo">
      ${
        myClient
          ? clientAreaHTML(myClient, false)
          : `<p class="muted-note" style="text-align:center;padding:60px 0;">Nenhuma ficha de treino vinculada ao seu email ainda. Fale com seu personal.</p>`
      }
    </div>`;
}

// ---------------- ÁREA DE TREINOS (compartilhada treinador/aluno) ----------------

function dayVolume(day) {
  let total = 0, done = 0;
  for (const ex of day.exercises || []) {
    for (const s of ex.sets || []) {
      total++;
      if (s.repsDone) done++;
    }
  }
  return { done, total };
}

const MUSCLE_GROUPS = [
  "Peito", "Costas", "Ombro", "Trapézio", "Bíceps", "Tríceps", "Antebraço",
  "Quadríceps", "Posterior de coxa", "Glúteo", "Adutores", "Panturrilha", "Abdômen", "Lombar",
];

// tenta adivinhar o grupo muscular pelo nome do exercício (o treinador pode corrigir depois)
function guessMuscle(name) {
  const n = (name || "").toLowerCase();
  const test = (...words) => words.some((w) => n.includes(w));
  if (test("supino", "peck deck", "peckdeck", "crucifixo", "cross over", "crossover", "voador")) return "Peito";
  if (test("puxada", "remada", "pulldown", "barra fixa", "pull-up", "pulley costas", "levantamento terra", "terra convencional")) return "Costas";
  if (test("desenvolvimento", "elevação lateral", "elevacao lateral", "elevação frontal", "arnold")) return "Ombro";
  if (test("encolhimento", "trapézio", "trapezio")) return "Trapézio";
  if (test("rosca") && !test("rosca inversa punho")) return "Bíceps";
  if (test("tríceps", "triceps", "jm press", "francês", "frances", "testa")) return "Tríceps";
  if (test("punho", "antebraço", "antebraco")) return "Antebraço";
  if (test("panturrilha", "flexão plantar", "flexao plantar")) return "Panturrilha";
  if (test("agachamento", "leg press", "cadeira extensora", "hack", "avanço", "avanco", "afundo")) return "Quadríceps";
  if (test("stiff", "cadeira flexora", "mesa flexora", "flexão de joelho", "flexao de joelho", "flexão nórdica", "flexao nordica")) return "Posterior de coxa";
  if (test("glúteo", "gluteo", "hip thrust", "elevação pélvica", "elevacao pelvica", "coice")) return "Glúteo";
  if (test("adutora", "adutor")) return "Adutores";
  if (test("abdominal", "abs supra", "abs infra", "prancha", "abdômen", "abdomen")) return "Abdômen";
  if (test("lombar", "extensão de tronco", "extensao de tronco", "hiperextensão", "hiperextensao")) return "Lombar";
  return "";
}

function muscleVolume(day) {
  const byMuscle = {};
  for (const ex of day.exercises || []) {
    const muscle = ex.muscle || "";
    if (!muscle) continue;
    if (!byMuscle[muscle]) byMuscle[muscle] = { done: 0, total: 0 };
    for (const s of ex.sets || []) {
      byMuscle[muscle].total++;
      if (s.repsDone) byMuscle[muscle].done++;
    }
  }
  return Object.entries(byMuscle).sort((a, b) => b[1].total - a[1].total);
}

function clientAreaHTML(client, editable) {
  if (editable && ui.progOpen) return progressionHTML(client);

  const day = (client.days || []).find((d) => d.id === ui.activeDayId);

  if (!day) {
    return `
      ${
        editable
          ? `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
               <button class="dashed-btn" id="open-import-modal"><i class="ti ti-clipboard-text"></i> Importar treino (colar texto)</button>
               <button class="dashed-btn" id="open-progression"><i class="ti ti-chart-line"></i> Progressão</button>
               <button class="dashed-btn" id="open-duplicate"><i class="ti ti-copy"></i> Duplicar treinos p/ outro aluno</button>
             </div>`
          : ""
      }
      <div class="grid ${editable ? "" : "stacked"}">
        ${(client.days || [])
          .map((d, dayIdx, dayArr) => {
            const vol = dayVolume(d);
            return `
          <div class="sq" data-open="${d.id}" ${editable ? 'draggable="true"' : ""}>
            ${
              editable
                ? `<div class="sq-toolbar">
                    <button class="move-btn" data-daymove="up" data-dayid="${d.id}" ${dayIdx === 0 ? "disabled" : ""}><i class="ti ti-chevron-up"></i></button>
                    <button class="move-btn" data-daymove="down" data-dayid="${d.id}" ${dayIdx === dayArr.length - 1 ? "disabled" : ""}><i class="ti ti-chevron-down"></i></button>
                    <span style="flex:1;"></span>
                    <button class="move-btn" data-rmday="${d.id}"><i class="ti ti-trash"></i></button>
                  </div>`
                : ""
            }
            <div style="color:var(--red);"><i class="ti ti-barbell" style="font-size:18px;"></i></div>
            <div>
              <div class="title display">${escapeHTML(d.title || "Sem título")}</div>
              <div class="count">${(d.exercises || []).length} exercício${(d.exercises || []).length !== 1 ? "s" : ""}</div>
              ${vol.total > 0 ? `<div class="count" style="color:${vol.done === vol.total ? "#639922" : "var(--muted)"};">${vol.done}/${vol.total} séries feitas</div>` : ""}
            </div>
          </div>`;
          })
          .join("")}
        ${editable ? `<div class="sq add" id="add-day-sq">+ novo treino</div>` : ""}
      </div>`;
  }

  return `
    <div class="day-head">
      <button class="back" id="back-to-grid"><i class="ti ti-chevron-left"></i> Semana</button>
      ${
        editable
          ? `<input class="display day-title" id="day-title-input" value="${attr(day.title)}" />`
          : `<div class="display day-title">${escapeHTML(day.title)}</div>`
      }
      ${editable ? `<button class="rm-x" id="rm-day"><i class="ti ti-trash"></i></button>` : ""}
    </div>
    ${
      (() => {
        const vol = dayVolume(day);
        if (vol.total === 0) return "";
        const byMuscle = muscleVolume(day);
        const totalLine = `<div class="muted-note" style="margin:-10px 0 8px; color:${vol.done === vol.total ? "#639922" : "var(--muted)"};">${vol.done}/${vol.total} séries feitas</div>`;
        const muscleLine =
          byMuscle.length > 0
            ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;">
                ${byMuscle
                  .map(
                    ([m, v]) =>
                      `<span class="muscle-vol-pill">${escapeHTML(m)}: <b>${v.done}/${v.total}</b></span>`
                  )
                  .join("")}
              </div>`
            : "";
        return totalLine + muscleLine;
      })()
    }
    <div id="exercises-wrap">
      ${(day.exercises || []).map((ex, i, arr) => exerciseHTML(ex, editable, i, arr.length)).join("")}
    </div>
    ${editable ? `<button class="dashed-btn" id="add-exercise">+ adicionar exercício</button>` : ""}
  `;
}

function exerciseHTML(ex, editable, index, total) {
  const collapsed = isCollapsed(ex.id);
  return `
    <div class="ex-card" data-exid="${ex.id}">
      <div class="ex-top">
        ${
          editable
            ? `<input class="ex-name" data-field="name" placeholder="Exercício" value="${attr(ex.name)}" />`
            : `<div class="ex-name">${escapeHTML(ex.name || "Exercício")}</div>`
        }
        ${
          editable
            ? `<span class="move-btns">
                <button class="move-btn" data-move="up" data-exmove="${ex.id}" ${index === 0 ? "disabled" : ""}><i class="ti ti-chevron-up"></i></button>
                <button class="move-btn" data-move="down" data-exmove="${ex.id}" ${index === total - 1 ? "disabled" : ""}><i class="ti ti-chevron-down"></i></button>
              </span>`
            : ""
        }
        ${editable ? `<button class="rm-x" data-rmex="${ex.id}"><i class="ti ti-x"></i></button>` : ""}
        <button class="ex-toggle ${collapsed ? "collapsed" : ""}" data-toggle="${ex.id}" aria-label="Abrir/fechar exercício">▾</button>
      </div>
      ${
        editable
          ? `<select class="muscle-select" data-field="muscle">
              <option value="">Grupo muscular…</option>
              ${MUSCLE_GROUPS.map((m) => `<option value="${m}" ${ex.muscle === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>`
          : ex.muscle
          ? `<span class="muscle-tag">${escapeHTML(ex.muscle)}</span>`
          : ""
      }
      <div class="ex-body ${collapsed ? "hidden" : ""}">
        <div class="notes-box">
          <label>ANOTAÇÕES</label>
          <textarea rows="3" data-field="notes" data-autogrow="1" placeholder="ex.: preparatória com 2 séries leves de 15 reps; trabalho com cadência 2-0-2, descanso 90s"
            ${editable ? "" : "readonly"}>${escapeHTML(ex.notes || "")}</textarea>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">SÉRIES DE TRABALHO</label>
          ${(ex.sets || []).map((s, i) => setRowHTML(ex.id, s, i, editable)).join("")}
          ${editable ? `<button class="dashed-btn" data-addset="${ex.id}" style="margin-top:6px;">+ série</button>` : ""}
        </div>
      </div>
    </div>`;
}

function setRowHTML(exId, s, i, editable) {
  const goal = s.repsGoal ?? s.reps ?? ""; // compatível com fichas antigas (campo único "reps")
  const rirOn = !!s.rirEnabled;
  return `
    <div class="set-row" data-setid="${s.id}" data-exid="${exId}">
      <span class="set-idx">${i + 1}ª</span>
      <span class="stack" style="color:var(--plate);">
        <span class="box meta grow"><input data-field="repsGoal" data-grow="1" value="${attr(goal)}" placeholder="meta" ${editable ? "" : "readonly"} /></span>
        <span class="unit">meta</span>
      </span>
      <span class="stack" style="color:var(--chalk);position:relative;">
        ${
          editable
            ? `<span class="box"><input data-field="repsDone" data-grow="1" value="${attr(s.repsDone)}" placeholder="0" /></span>`
            : `<button type="button" class="box feito-open" data-feitoopen="1">${escapeHTML(s.repsDone || "–")}</button>`
        }
        <span class="unit">feito</span>
      </span>
      <span class="stack" style="color:var(--steel);">
        <span class="box kg grow"><input data-field="load" data-grow="1" value="${attr(s.load)}" /></span>
        <span class="unit">kg</span>
      </span>
      ${
        editable
          ? `<span class="stack" style="color:var(--plate);">
              <span class="box rir grow"><input data-field="rir" data-grow="1" value="${attr(s.rir)}" placeholder="-" /></span>
              <span class="unit" style="display:flex;align-items:center;gap:2px;">
                rir
                <button type="button" class="rir-toggle ${rirOn ? "on" : ""}" data-rirtoggle="1" title="${rirOn ? "Aluno pode editar" : "Só você edita"}"><i class="ti ${rirOn ? "ti-lock-open" : "ti-lock"}"></i></button>
              </span>
            </span>`
          : rirOn
          ? `<span class="stack" style="color:var(--plate);">
              <span class="box rir"><input data-field="rir" value="${attr(s.rir)}" placeholder="-" /></span>
              <span class="unit">rir</span>
            </span>`
          : ""
      }
      ${editable ? `<button class="rm-x" data-rmset="1"><i class="ti ti-x"></i></button>` : ""}
    </div>`;
}

// ---------- eventos da área de treinos (funciona pra treinador e aluno) ----------

function wireClientArea(client, editable) {
  if (!client) return;

  if (editable && ui.progOpen) {
    wireProgression(client);
    return;
  }

  if (editable) {
    wireImportModal(client);
    wireDuplicateModal(client);
  }

  const openProgBtn = document.getElementById("open-progression");
  if (openProgBtn) {
    openProgBtn.onclick = () => {
      ui.progOpen = true;
      render();
    };
  }

  // grade
  document.querySelectorAll("[data-open]").forEach((sq) => {
    sq.onclick = (e) => {
      if (e.target.closest("[data-rmday]") || e.target.closest("[data-daymove]")) return;
      ui.activeDayId = sq.dataset.open;
      render();
    };
  });
  const addDaySq = el("add-day-sq");
  if (addDaySq) addDaySq.onclick = () => {
    const days = [...(client.days || []), emptyDay(`Treino ${String.fromCharCode(65 + (client.days || []).length)}`)];
    ui.activeDayId = days[days.length - 1].id;
    updateDays(client, days);
  };
  document.querySelectorAll("[data-rmday]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const day = (client.days || []).find((d) => d.id === btn.dataset.rmday);
      const name = day ? day.title || "este treino" : "este treino";
      if (!confirm(`Excluir "${name}"? Todos os exercícios dele serão apagados. Essa ação não pode ser desfeita.`)) return;
      updateDays(client, (client.days || []).filter((d) => d.id !== btn.dataset.rmday));
    };
  });
  document.querySelectorAll("[data-daymove]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.dayid;
      const dir = btn.dataset.daymove;
      const list = [...(client.days || [])];
      const idx = list.findIndex((d) => d.id === dayId);
      const swapWith = dir === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapWith < 0 || swapWith >= list.length) return;
      [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
      updateDays(client, list);
    };
  });

  if (editable) {
    document.querySelectorAll("[data-open]").forEach((sq) => {
      sq.addEventListener("dragstart", (e) => {
        draggedDayId = sq.dataset.open;
        sq.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      sq.addEventListener("dragend", () => {
        sq.classList.remove("dragging");
        document.querySelectorAll(".sq.drag-over").forEach((el2) => el2.classList.remove("drag-over"));
      });
      sq.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (sq.dataset.open !== draggedDayId) sq.classList.add("drag-over");
      });
      sq.addEventListener("dragleave", () => sq.classList.remove("drag-over"));
      sq.addEventListener("drop", (e) => {
        e.preventDefault();
        sq.classList.remove("drag-over");
        const targetId = sq.dataset.open;
        if (!draggedDayId || draggedDayId === targetId) return;
        const list = [...(client.days || [])];
        const fromIdx = list.findIndex((d) => d.id === draggedDayId);
        const toIdx = list.findIndex((d) => d.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        draggedDayId = null;
        updateDays(client, list);
      });
    });
  }

  // detalhe do dia
  const backBtn = el("back-to-grid");
  if (backBtn) backBtn.onclick = () => { ui.activeDayId = null; render(); };

  const dayTitleInput = el("day-title-input");
  if (dayTitleInput) dayTitleInput.onchange = () => {
    const days = (client.days || []).map((d) => (d.id === ui.activeDayId ? { ...d, title: dayTitleInput.value } : d));
    updateDays(client, days);
  };

  const rmDayBtn = el("rm-day");
  if (rmDayBtn) rmDayBtn.onclick = () => {
    const current = (client.days || []).find((d) => d.id === ui.activeDayId);
    const name = current ? current.title || "este treino" : "este treino";
    if (!confirm(`Excluir "${name}"? Todos os exercícios dele serão apagados. Essa ação não pode ser desfeita.`)) return;
    const days = (client.days || []).filter((d) => d.id !== ui.activeDayId);
    ui.activeDayId = null;
    updateDays(client, days);
  };

  const addExBtn = el("add-exercise");
  if (addExBtn) addExBtn.onclick = () => {
    const days = (client.days || []).map((d) =>
      d.id === ui.activeDayId ? { ...d, exercises: [...(d.exercises || []), emptyExercise()] } : d
    );
    updateDays(client, days);
  };

  // exercícios
  document.querySelectorAll("[data-rmex]").forEach((btn) => {
    btn.onclick = () => {
      const exName = btn.closest(".ex-card")?.querySelector(".ex-name")?.value
        || btn.closest(".ex-card")?.querySelector(".ex-name")?.textContent
        || "este exercício";
      if (!confirm(`Excluir "${exName}"? Essa ação não pode ser desfeita.`)) return;
      const days = (client.days || []).map((d) =>
        d.id === ui.activeDayId ? { ...d, exercises: (d.exercises || []).filter((ex) => ex.id !== btn.dataset.rmex) } : d
      );
      updateDays(client, days);
    };
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.toggle;
      collapsedEx[exId] = !isCollapsed(exId);
      render();
    };
  });

  document.querySelectorAll("[data-exmove]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.exmove;
      const dir = btn.dataset.move; // "up" ou "down"
      const days = (client.days || []).map((d) => {
        if (d.id !== ui.activeDayId) return d;
        const list = [...(d.exercises || [])];
        const idx = list.findIndex((ex) => ex.id === exId);
        const swapWith = dir === "up" ? idx - 1 : idx + 1;
        if (idx < 0 || swapWith < 0 || swapWith >= list.length) return d;
        [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
        return { ...d, exercises: list };
      });
      updateDays(client, days);
    };
  });

  document.querySelectorAll(".ex-card").forEach((card) => {
    const exId = card.dataset.exid;
    card.querySelectorAll("[data-field]").forEach((input) => {
      if (input.closest(".set-row")) return; // séries tratadas abaixo
      input.onchange = () => {
        const field = input.dataset.field;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, [field]: input.value } : ex)),
          };
        });
        updateDays(client, days);
      };
    });

    card.querySelectorAll("[data-autogrow]").forEach((el) => {
      growTextarea(el);
      el.oninput = () => growTextarea(el);
    });

    const addSetBtn = card.querySelector(`[data-addset="${exId}"]`);
    if (addSetBtn) addSetBtn.onclick = () => {
      const days = (client.days || []).map((d) => {
        if (d.id !== ui.activeDayId) return d;
        return {
          ...d,
          exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, sets: [...(ex.sets || []), emptySet()] } : ex)),
        };
      });
      updateDays(client, days);
    };
  });

  // séries: reps e kg sempre editáveis (mesmo pro aluno); resto só se editable
  document.querySelectorAll(".set-row").forEach((row) => {
    const exId = row.dataset.exid;
    const setId = row.dataset.setid;

    row.querySelectorAll("[data-field]").forEach((input) => {
      input.onchange = () => {
        saveSetField(client, ui.activeDayId, exId, setId, input.dataset.field, input.value);
      };
    });

    // meta e kg crescem conforme o personal digita
    row.querySelectorAll("[data-grow]").forEach((input) => {
      growBox(input);
      input.oninput = () => growBox(input);
    });

    // "feito" abre um bloco próprio de rolagem (estilo roleta) pra escolher 1 a 15
    const feitoBtn = row.querySelector("[data-feitoopen]");
    if (feitoBtn) {
      feitoBtn.onclick = () => openFeitoPicker(client, exId, setId, feitoBtn.textContent.trim());
    }

    if (editable) {
      const rirToggleBtn = row.querySelector("[data-rirtoggle]");
      if (rirToggleBtn) {
        rirToggleBtn.onclick = () => {
          const days = (client.days || []).map((d) => {
            if (d.id !== ui.activeDayId) return d;
            return {
              ...d,
              exercises: (d.exercises || []).map((ex) => {
                if (ex.id !== exId) return ex;
                return {
                  ...ex,
                  sets: (ex.sets || []).map((s) => (s.id === setId ? { ...s, rirEnabled: !s.rirEnabled } : s)),
                };
              }),
            };
          });
          updateDays(client, days);
        };
      }

      const rmSetBtn = row.querySelector("[data-rmset]");
      if (rmSetBtn) rmSetBtn.onclick = () => {
        if (!confirm("Excluir essa série?")) return;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              if ((ex.sets || []).length <= 1) return ex;
              return { ...ex, sets: ex.sets.filter((s) => s.id !== setId) };
            }),
          };
        });
        updateDays(client, days);
      };
    }

    // campos que não são reps/kg ficam travados fora do modo editável
    if (!editable) {
      row.querySelectorAll("[data-field]").forEach((input) => {
        // reps e kg continuam liberados; nada a fazer aqui, já são editáveis por padrão
      });
    }
  });

  // fora das set-rows, tudo trava se não editável (nome do exercício, notas, título do dia etc. já
  // são renderizados como texto/readonly quando editable=false — ver funções acima)
}

// ---------- histórico de progressão (reps/kg por semana) ----------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekKeyOf(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // volta pra segunda-feira daquela semana
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

// aplica a mudança de um campo (reps/kg/etc.) numa série e, se for reps/kg,
// já grava uma entrada no histórico (substituindo qualquer entrada da mesma
// série feita no mesmo dia, pra não acumular lixo com múltiplas edições)
function applySetFieldChange(client, dayId, exId, setId, field, value) {
  let dayTitle = "", exName = "", setIndex = 0;
  const days = (client.days || []).map((d) => {
    if (d.id !== dayId) return d;
    dayTitle = d.title;
    return {
      ...d,
      exercises: (d.exercises || []).map((ex) => {
        if (ex.id !== exId) return ex;
        exName = ex.name;
        return {
          ...ex,
          sets: (ex.sets || []).map((s, i) => {
            if (s.id !== setId) return s;
            setIndex = i;
            return { ...s, [field]: value };
          }),
        };
      }),
    };
  });

  let history = client.history || [];
  if (field === "repsDone" || field === "load") {
    const dateKey = todayKey();
    history = history.filter((h) => !(h.setId === setId && h.dateKey === dateKey));
    const day = days.find((d) => d.id === dayId);
    const ex = day?.exercises.find((e) => e.id === exId);
    const set = ex?.sets.find((s) => s.id === setId);
    history = [
      ...history,
      {
        dateKey,
        weekKey: weekKeyOf(dateKey),
        dayId, dayTitle, exId, exName, setId, setIndex,
        repsGoal: set?.repsGoal || "",
        repsDone: set?.repsDone || "",
        load: set?.load || "",
      },
    ];
  }
  return { days, history };
}

function saveSetField(client, dayId, exId, setId, field, value) {
  const { days, history } = applySetFieldChange(client, dayId, exId, setId, field, value);
  saveClient(client.id, { days, history });
}



const WEEKDAY_RE = /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i;

function stripStars(line) {
  return line.replace(/^\*+/, "").replace(/\*+$/, "").trim();
}

// extrai tipo de série / RIR / carga / observações do texto que sobrou
// depois do "Nx" e do range de reps
function extractRest(count, range, rest) {
  let load = "";
  let rir = "";

  const rirMatch = rest.match(/(\d+)\s*rir\b/i);
  if (rirMatch) rir = rirMatch[1];

  const placaMatch = rest.match(/placa\s*(\d+)/i);
  const kgMatch = rest.match(/([\d]+(?:[.,]\d+)?)\s*kg/i);

  if (placaMatch) {
    load = `Placa ${placaMatch[1]}`;
  } else if (/zerada|sem peso/i.test(rest)) {
    load = "0";
  } else if (kgMatch) {
    load = kgMatch[1];
  } else if (/peso do corpo|\bcorpo\b/i.test(rest)) {
    load = "corpo";
  }

  // o que sobrar (não virou range/kg/rir) vira observação, pra não perder informação
  // (ex.: "cluster 4x4r", "restp", "sem strap" continuam visíveis no texto)
  let leftover = rest;
  [rirMatch, placaMatch, kgMatch].forEach((m) => {
    if (m) leftover = leftover.replace(m[0], "");
  });
  leftover = leftover.replace(/zerada|sem peso|peso do corpo|\bkg\b/gi, "");
  leftover = leftover.replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "").trim();

  return { count, range, load, done: "", rir, extraNote: leftover };
}

function parseWorkLine(line) {
  // formato limpo: "NxRANGEr resto"
  const clean = line.match(/^(\d+)\s*x\s*(\d+)(?:[-\s]+(\d+))?\s*r\b(.*)$/i);
  if (clean) {
    const count = parseInt(clean[1], 10) || 1;
    const range = clean[3] ? `${clean[2]}-${clean[3]}` : clean[2];
    return extractRest(count, range, clean[4] || "");
  }

  // formato solto: "Nx resto qualquer" (placa, cluster, etc. sem range logo depois do x)
  const loose = line.match(/^(\d+)\s*x\s*(.*)$/i);
  if (loose) {
    const count = parseInt(loose[1], 10) || 1;
    const rest = loose[2] || "";
    const restForRange = rest.replace(/placa\s*\d+/i, ""); // evita o nº da placa virar "reps" por engano
    const rangeMatch = restForRange.match(/(\d+)(?:[-\s]+(\d+))?\s*r\b/i);
    const range = rangeMatch ? (rangeMatch[2] ? `${rangeMatch[1]}-${rangeMatch[2]}` : rangeMatch[1]) : "";
    return extractRest(count, range, rest);
  }

  return null;
}

function isPrepLine(line) {
  // linhas de aquecimento sem "-" na frente, tipo "12r 0kg" ou "5 8r 40kg"
  return /^\d+(?:[-\s]+\d+)?\s*r\b/i.test(line) && !/^\d+\s*x/i.test(line);
}

function looksLikeInstruction(line) {
  // linhas de instrução geral (não são nem exercício nem série), tipo "Descanso no máximo 1m30"
  return /^(descanso|obs|observa[cç][aã]o|dica)\b/i.test(line);
}

function parseWorkoutText(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const days = [];
  let currentDay = null;
  let currentExercise = null;
  let started = false; // ignora linhas antes do 1º cabeçalho de dia (ex.: título da ficha)

  const ensureExercise = () => {
    if (!currentExercise) {
      currentExercise = { id: uid(), name: "Aquecimento / Mobilidade", notes: "", sets: [], _notesArr: [] };
      currentDay.exercises.push(currentExercise);
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const stripped = stripStars(line);
    if (WEEKDAY_RE.test(line)) {
      currentDay = { id: uid(), title: stripped, exercises: [] };
      days.push(currentDay);
      currentExercise = null;
      started = true;
      continue;
    }
    if (!started) continue;

    if (line.startsWith("-")) {
      ensureExercise();
      currentExercise._notesArr.push(line.slice(1).trim());
      continue;
    }

    const work = parseWorkLine(line);
    if (work) {
      ensureExercise();
      for (let n = 0; n < work.count; n++) {
        currentExercise.sets.push({
          id: uid(),
          repsGoal: work.range,
          repsDone: work.done,
          load: work.load,
          intensity: 0,
          rir: work.rir,
          rirEnabled: false,
        });
      }
      if (work.extraNote) {
        currentExercise._notesArr.push(`(série ${currentExercise.sets.length}) ${work.extraNote}`);
      }
      continue;
    }

    if (isPrepLine(line)) {
      ensureExercise();
      currentExercise._notesArr.push(line);
      continue;
    }

    if (line.startsWith("*") || (line.startsWith("(") && line.endsWith(")"))) {
      ensureExercise();
      currentExercise._notesArr.push(stripStars(line).replace(/^\(|\)$/g, ""));
      continue;
    }

    if (looksLikeInstruction(line)) {
      ensureExercise();
      currentExercise._notesArr.push(line);
      continue;
    }

    // qualquer outra linha = nome de um novo exercício
    const exName = line.replace(/:$/, "");
    currentExercise = { id: uid(), name: exName, muscle: guessMuscle(exName), notes: "", sets: [], _notesArr: [] };
    currentDay.exercises.push(currentExercise);
  }

  for (const day of days) {
    for (const ex of day.exercises) {
      ex.notes = ex._notesArr.join("; ");
      delete ex._notesArr;
    }
  }
  return days;
}

function openImportModal() {
  document.getElementById("import-modal").classList.remove("hidden");
  document.getElementById("im-text").value = "";
  document.getElementById("im-error").textContent = "";
}
function closeImportModal() {
  document.getElementById("import-modal").classList.add("hidden");
}

function wireImportModal(client) {
  const openBtn = document.getElementById("open-import-modal");
  if (openBtn) openBtn.onclick = openImportModal;

  const cancelBtn = document.getElementById("im-cancel");
  const backdrop = document.getElementById("im-backdrop");
  if (cancelBtn) cancelBtn.onclick = closeImportModal;
  if (backdrop) backdrop.onclick = closeImportModal;

  const confirmBtn = document.getElementById("im-confirm");
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const text = document.getElementById("im-text").value;
      const errorEl = document.getElementById("im-error");
      if (!text.trim()) {
        errorEl.textContent = "Cole o texto do treino antes de importar.";
        return;
      }
      const parsedDays = parseWorkoutText(text);
      if (parsedDays.length === 0) {
        errorEl.textContent = "Não encontrei nenhum dia da semana nesse texto (ex.: \"Segunda-feira\"). Confira o formato.";
        return;
      }
      const totalEx = parsedDays.reduce((sum, d) => sum + d.exercises.length, 0);
      if (!confirm(`Encontrei ${parsedDays.length} dia(s) de treino e ${totalEx} exercícios. Isso vai ADICIONAR esses treinos aos que o aluno já tem (sem apagar nada existente). Continuar?`)) {
        return;
      }
      const nextDays = [...(client.days || []), ...parsedDays];
      updateDays(client, nextDays);
      closeImportModal();
    };
  }
}

function openDuplicateModal(sourceName) {
  document.getElementById("dup-modal").classList.remove("hidden");
  document.getElementById("dup-source-name").textContent = sourceName;
  document.getElementById("dup-name").value = "";
  document.getElementById("dup-email").value = "";
  document.getElementById("dup-pass").value = "";
  document.getElementById("dup-error").textContent = "";
}
function closeDuplicateModal() {
  document.getElementById("dup-modal").classList.add("hidden");
}

function wireDuplicateModal(client) {
  const openBtn = document.getElementById("open-duplicate");
  if (openBtn) openBtn.onclick = () => openDuplicateModal(client.name);

  const cancelBtn = document.getElementById("dup-cancel");
  const backdrop = document.getElementById("dup-backdrop");
  if (cancelBtn) cancelBtn.onclick = closeDuplicateModal;
  if (backdrop) backdrop.onclick = closeDuplicateModal;

  const confirmBtn = document.getElementById("dup-confirm");
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const name = document.getElementById("dup-name").value.trim();
      const email = document.getElementById("dup-email").value.trim();
      const pass = document.getElementById("dup-pass").value;
      const errorEl = document.getElementById("dup-error");
      errorEl.textContent = "";
      if (!name || !email || pass.length < 6) {
        errorEl.textContent = "Preencha nome, email e uma senha com 6+ caracteres.";
        return;
      }
      confirmBtn.textContent = "Criando…";
      try {
        await createStudent(name, email, pass, client.days || []);
        closeDuplicateModal();
      } catch (e) {
        errorEl.textContent = traduzErro(e.code);
      } finally {
        confirmBtn.textContent = "Criar e copiar";
      }
    };
  }
}

// ---------- bloco de rolagem (estilo roleta) pro campo "feito" ----------

const FEITO_ITEM_H = 44;

function closeFeitoPicker() {
  const el = document.getElementById("feito-picker");
  if (el) el.classList.add("hidden");
}

function openFeitoPicker(client, exId, setId, currentVal) {
  const el = document.getElementById("feito-picker");
  const nums = Array.from({ length: 15 }, (_, i) => i + 1);

  el.innerHTML = `
    <div class="fp-backdrop" id="fp-backdrop"></div>
    <div class="fp-card">
      <div class="fp-title">Quantas repetições você fez?</div>
      <div class="fp-scroll" id="fp-scroll">
        <div class="fp-pad"></div>
        ${nums
          .map((n) => `<div class="fp-item ${String(n) === String(currentVal) ? "selected" : ""}" data-num="${n}">${n}</div>`)
          .join("")}
        <div class="fp-pad"></div>
      </div>
      <button type="button" class="fp-cancel" id="fp-cancel">Cancelar</button>
    </div>`;
  el.classList.remove("hidden");

  const scrollEl = document.getElementById("fp-scroll");
  const idx = Math.max(0, nums.indexOf(Number(currentVal)));
  scrollEl.scrollTop = idx * FEITO_ITEM_H;

  el.querySelectorAll("[data-num]").forEach((item) => {
    item.onclick = () => {
      const value = item.dataset.num;
      saveSetField(client, ui.activeDayId, exId, setId, "repsDone", value);
      closeFeitoPicker();
    };
  });

  document.getElementById("fp-backdrop").onclick = closeFeitoPicker;
  document.getElementById("fp-cancel").onclick = closeFeitoPicker;
}

// ---------- tela de progressão (tabela + gráfico, só treinador) ----------

function weekLabel(weekKey) {
  const d = new Date(weekKey + "T00:00:00");
  const day = String(d.getDate()).padStart(2, "0");
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${day}/${months[d.getMonth()]}`;
}

function buildHistoryIndex(client) {
  const hist = client.history || [];
  const bySet = {};
  for (const h of hist) {
    if (!bySet[h.setId]) {
      bySet[h.setId] = { setId: h.setId, exId: h.exId, label: `${h.exName || "Exercício"} (${h.setIndex + 1}ª)`, dayTitle: h.dayTitle, entries: [] };
    }
    bySet[h.setId].entries.push(h);
  }
  return Object.values(bySet);
}

function allWeekKeys(client) {
  const set = new Set((client.history || []).map((h) => h.weekKey));
  return Array.from(set).sort();
}

function latestInWeek(entries, weekKey) {
  const inWeek = entries.filter((e) => e.weekKey === weekKey);
  if (inWeek.length === 0) return null;
  return inWeek.reduce((a, b) => (a.dateKey > b.dateKey ? a : b));
}

function progressionHTML(client) {
  const rows = buildHistoryIndex(client);
  const weeks = allWeekKeys(client).slice(-8);
  return `
    <div class="day-head">
      <button class="back" id="prog-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title">Progressão</div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button class="dashed-btn" id="prog-tab-table" style="${ui.progMode === "table" ? "border-style:solid;color:var(--chalk);" : ""}">Tabela</button>
      <button class="dashed-btn" id="prog-tab-chart" style="${ui.progMode === "chart" ? "border-style:solid;color:var(--chalk);" : ""}">Gráfico</button>
    </div>
    ${
      rows.length === 0
        ? `<p class="muted-note">Ainda não há histórico. Assim que reps ou kg forem alterados pelo aluno (ou por você), a progressão aparece aqui, semana a semana.</p>`
        : ui.progMode === "table"
        ? progTableHTML(rows, weeks)
        : progChartHTML(rows)
    }`;
}

function progTableHTML(rows, weeks) {
  return `
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse; width:100%; font-size:12px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:6px 10px; color:var(--muted); font-weight:600; white-space:nowrap; position:sticky; left:0; background:var(--panel);">Série</th>
            ${weeks.map((w) => `<th style="padding:6px 10px; color:var(--muted); font-weight:600; white-space:nowrap;">${weekLabel(w)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r) => {
              let prevVal = null;
              const cells = weeks
                .map((w) => {
                  const e = latestInWeek(r.entries, w);
                  if (!e) return `<td style="padding:6px 10px; text-align:center; color:var(--line);">—</td>`;
                  const raw = e.load || e.repsDone || "";
                  const num = parseFloat(String(raw).replace(",", "."));
                  let arrow = "";
                  if (prevVal != null && !isNaN(num)) {
                    if (num > prevVal) arrow = ` <span style="color:#639922;"><i class="ti ti-arrow-up"></i></span>`;
                    else if (num < prevVal) arrow = ` <span style="color:#E24B4A;"><i class="ti ti-arrow-down"></i></span>`;
                  }
                  if (!isNaN(num)) prevVal = num;
                  const label = `${e.repsDone || e.repsGoal || "-"}r${e.load ? " · " + e.load + "kg" : ""}`;
                  return `<td style="padding:6px 10px; text-align:center; white-space:nowrap; color:var(--chalk);">${label}${arrow}</td>`;
                })
                .join("");
              return `<tr style="border-top:1px solid var(--line);">
                <td style="padding:6px 10px; white-space:nowrap; position:sticky; left:0; background:var(--bg); color:var(--chalk);">${escapeHTML(r.label)}</td>
                ${cells}
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function progChartHTML(rows) {
  const selected = ui.progKey && rows.find((r) => r.setId === ui.progKey) ? ui.progKey : rows[0] && rows[0].setId;
  ui.progKey = selected;
  return `
    <select id="prog-select" style="width:100%; margin-bottom:14px; padding:9px; background:var(--panelAlt); border:1px solid var(--line); border-radius:8px; color:var(--chalk); font-size:14px;">
      ${rows
        .map((r) => `<option value="${r.setId}" ${r.setId === selected ? "selected" : ""}>${escapeHTML(r.label)}${r.dayTitle ? " — " + escapeHTML(r.dayTitle) : ""}</option>`)
        .join("")}
    </select>
    <div style="position:relative; width:100%; height:240px;">
      <canvas id="prog-canvas"></canvas>
    </div>`;
}

let progChartInstance = null;

function renderProgChart(client) {
  const canvas = document.getElementById("prog-canvas");
  if (!canvas || !window.Chart) return;
  const entries = (client.history || []).filter((h) => h.setId === ui.progKey);
  const byWeek = {};
  for (const e of entries) {
    if (!byWeek[e.weekKey] || e.dateKey > byWeek[e.weekKey].dateKey) byWeek[e.weekKey] = e;
  }
  const weeks = Object.keys(byWeek).sort();
  const labels = weeks.map(weekLabel);
  const useLoad = weeks.some((w) => byWeek[w].load);
  const data = weeks.map((w) => {
    const v = useLoad ? byWeek[w].load : byWeek[w].repsDone;
    const n = parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? null : n;
  });

  if (progChartInstance) progChartInstance.destroy();
  progChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: "#FF4433",
          backgroundColor: "rgba(255,68,51,0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: "#FF4433",
          pointBorderColor: "#17161A",
          pointBorderWidth: 2,
          borderWidth: 2,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { color: "#9A94A6", font: { size: 11 } }, grid: { color: "#2A2830" } },
        x: { ticks: { color: "#9A94A6", font: { size: 11 } }, grid: { display: false } },
      },
    },
  });
}

function wireProgression(client) {
  const backBtn = document.getElementById("prog-back");
  if (backBtn) backBtn.onclick = () => { ui.progOpen = false; render(); };

  const tabTable = document.getElementById("prog-tab-table");
  const tabChart = document.getElementById("prog-tab-chart");
  if (tabTable) tabTable.onclick = () => { ui.progMode = "table"; render(); };
  if (tabChart) tabChart.onclick = () => { ui.progMode = "chart"; render(); };

  if (ui.progMode === "chart") {
    const select = document.getElementById("prog-select");
    if (select) {
      select.onchange = () => { ui.progKey = select.value; render(); };
      renderProgChart(client);
    }
  }
}

// ---------- crescimento automático dos quadrados meta/kg ----------

function growBox(input) {
  const box = input.closest(".box");
  if (!box) return;
  const len = (input.value || "").length;
  box.style.width = Math.max(30, len * 11 + 22) + "px";
}

function growTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}


// ---------- utilitários ----------

function escapeHTML(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(str) { return escapeHTML(str).replace(/\n/g, "&#10;"); }

// ---------- banner "instalar app" ----------

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner("android");
});

function showInstallBanner(kind) {
  if (isStandalone()) return; // já instalado, não precisa avisar
  if (localStorage.getItem("install-banner-dismissed") === "1") return;

  const el = document.getElementById("install-banner");
  el.classList.remove("hidden");

  if (kind === "android") {
    el.innerHTML = `<span>Instale este app no seu celular pra acesso rápido, direto da tela inicial.</span>
      <button id="ib-install">Instalar</button>
      <button id="ib-dismiss"><i class="ti ti-x"></i></button>`;
    el.querySelector("#ib-install").onclick = async () => {
      el.classList.add("hidden");
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
      }
    };
  } else {
    el.innerHTML = `<span>Toque em <b>Compartilhar</b> (⬆️) e depois em <b>"Adicionar à Tela de Início"</b> pra instalar o app.</span>
      <button id="ib-dismiss"><i class="ti ti-x"></i></button>`;
  }

  el.querySelector("#ib-dismiss").onclick = () => {
    el.classList.add("hidden");
    localStorage.setItem("install-banner-dismissed", "1");
  };
}

window.addEventListener("load", () => {
  if (isIOS() && !isStandalone()) {
    setTimeout(() => showInstallBanner("ios"), 1500);
  }
});
