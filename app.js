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

let ui = { view: "loading", selectedId: null, activeDayId: null };

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
async function createStudent(name, email, password) {
  const secondary = firebase.apps.find((a) => a.name === "Secondary") || firebase.initializeApp(firebaseConfig, "Secondary");
  const secAuth = secondary.auth();
  const cred = await secAuth.createUserWithEmailAndPassword(email.toLowerCase(), password);
  await secAuth.signOut();

  await db.collection("clients").doc(cred.user.uid).set({
    name,
    email: email.toLowerCase(),
    goal: "",
    days: [],
    createdAt: Date.now(),
  });
}

async function removeStudentDoc(clientId) {
  // remove só a ficha de treino (não a conta de login — isso exige o
  // Admin SDK, fora do alcance do app do navegador)
  await db.collection("clients").doc(clientId).delete();
}

// ---------- leitura/escrita dos dados de treino ----------

function saveClient(id, patch) {
  db.collection("clients").doc(id).update(patch).catch((e) => alert("Erro ao salvar: " + e.message));
}

function emptySet() { return { id: uid(), reps: "10", load: "", intensity: 0 }; }
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
    wireClientArea(myClient, false);
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
            .map(
              (c) => `
            <div class="client-row ${c.id === ui.selectedId ? "active" : ""}" data-id="${c.id}">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="cn" style="flex:1;">${escapeHTML(c.name)}</span>
                <button class="copy-btn" data-copy="${c.id}">copiar login</button>
              </div>
              <span class="ce">${escapeHTML(c.email)}</span>
            </div>`
            )
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
      navigator.clipboard.writeText(`Email: ${c.email}\n(a senha é a que você cadastrou ao criar o aluno)`).catch(() => {});
      btn.textContent = "copiado!";
      setTimeout(() => (btn.textContent = "copiar login"), 1200);
    };
  });

  const selected = clients.find((c) => c.id === ui.selectedId);
  if (selected) wireClientArea(selected, true);
}

// ---------------- ALUNO ----------------

function studentHTML() {
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

function clientAreaHTML(client, editable) {
  const day = (client.days || []).find((d) => d.id === ui.activeDayId);

  if (!day) {
    return `
      <div class="grid">
        ${(client.days || [])
          .map(
            (d) => `
          <div class="sq" data-open="${d.id}">
            ${editable ? `<button class="rm" data-rmday="${d.id}">✕</button>` : ""}
            <div style="color:var(--red);">🏋</div>
            <div>
              <div class="title display">${escapeHTML(d.title || "Sem título")}</div>
              <div class="count">${(d.exercises || []).length} exercício${(d.exercises || []).length !== 1 ? "s" : ""}</div>
            </div>
          </div>`
          )
          .join("")}
        ${editable ? `<div class="sq add" id="add-day-sq">+ novo treino</div>` : ""}
      </div>`;
  }

  return `
    <div class="day-head">
      <button class="back" id="back-to-grid">‹ Semana</button>
      ${
        editable
          ? `<input class="display day-title" id="day-title-input" value="${attr(day.title)}" />`
          : `<div class="display day-title">${escapeHTML(day.title)}</div>`
      }
      ${editable ? `<button class="rm-x" id="rm-day">🗑</button>` : ""}
    </div>
    <div id="exercises-wrap">
      ${(day.exercises || []).map((ex) => exerciseHTML(ex, editable)).join("")}
    </div>
    ${editable ? `<button class="dashed-btn" id="add-exercise">+ adicionar exercício</button>` : ""}
  `;
}

function exerciseHTML(ex, editable) {
  return `
    <div class="ex-card" data-exid="${ex.id}">
      <div class="ex-top">
        ${
          editable
            ? `<input class="ex-name" data-field="name" placeholder="Exercício" value="${attr(ex.name)}" />`
            : `<div class="ex-name">${escapeHTML(ex.name || "Exercício")}</div>`
        }
        ${editable ? `<button class="rm-x" data-rmex="${ex.id}">✕</button>` : ""}
      </div>
      <div class="notes-box">
        <label>ANOTAÇÕES</label>
        <textarea rows="3" data-field="notes" placeholder="ex.: preparatória com 2 séries leves de 15 reps; trabalho com cadência 2-0-2, descanso 90s"
          ${editable ? "" : "readonly"}>${escapeHTML(ex.notes || "")}</textarea>
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:var(--muted);">SÉRIES DE TRABALHO</label>
        ${(ex.sets || []).map((s, i) => setRowHTML(ex.id, s, i, editable)).join("")}
        ${editable ? `<button class="dashed-btn" data-addset="${ex.id}" style="margin-top:6px;">+ série</button>` : ""}
      </div>
    </div>`;
}

function setRowHTML(exId, s, i, editable) {
  return `
    <div class="set-row" data-setid="${s.id}" data-exid="${exId}">
      <span class="set-idx">${i + 1}ª</span>
      <span style="display:flex;align-items:center;gap:6px;color:var(--plate);">
        <span class="box"><input data-field="reps" value="${attr(s.reps)}" /></span>
        <span class="unit">reps</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;color:var(--steel);">
        <span class="box kg"><input data-field="load" value="${attr(s.load)}" /></span>
        <span class="unit">kg</span>
      </span>
      <span class="flames">
        ${[1, 2, 3, 4, 5].map((lvl) => `<button data-flame="${lvl}" class="${lvl <= (s.intensity || 0) ? "on" : ""}">🔥</button>`).join("")}
      </span>
      ${editable ? `<button class="rm-x" data-rmset="1">✕</button>` : ""}
    </div>`;
}

// ---------- eventos da área de treinos (funciona pra treinador e aluno) ----------

function wireClientArea(client, editable) {
  if (!client) return;

  // grade
  document.querySelectorAll("[data-open]").forEach((sq) => {
    sq.onclick = (e) => {
      if (e.target.closest("[data-rmday]")) return;
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
      updateDays(client, (client.days || []).filter((d) => d.id !== btn.dataset.rmday));
    };
  });

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
      const days = (client.days || []).map((d) =>
        d.id === ui.activeDayId ? { ...d, exercises: (d.exercises || []).filter((ex) => ex.id !== btn.dataset.rmex) } : d
      );
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
        const field = input.dataset.field;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              return { ...ex, sets: (ex.sets || []).map((s) => (s.id === setId ? { ...s, [field]: input.value } : s)) };
            }),
          };
        });
        updateDays(client, days);
      };
    });

    row.querySelectorAll("[data-flame]").forEach((btn) => {
      if (!editable) { btn.disabled = true; btn.style.opacity = btn.classList.contains("on") ? "1" : ".2"; return; }
      btn.onclick = () => {
        const lvl = Number(btn.dataset.flame);
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              return {
                ...ex,
                sets: (ex.sets || []).map((s) => {
                  if (s.id !== setId) return s;
                  return { ...s, intensity: s.intensity === lvl ? 0 : lvl };
                }),
              };
            }),
          };
        });
        updateDays(client, days);
      };
    });

    if (editable) {
      const rmSetBtn = row.querySelector("[data-rmset]");
      if (rmSetBtn) rmSetBtn.onclick = () => {
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

// ---------- utilitários ----------

function escapeHTML(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(str) { return escapeHTML(str).replace(/\n/g, "&#10;"); }
