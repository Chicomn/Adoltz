/***********************
 * CONFIG SUPABASE
 ***********************/
const SUPABASE_URL = "https://xbaciyedhjisfzkjdkvw.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiYWNpeWVkaGppc2Z6a2pka3Z3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY0MjIxOTEsImV4cCI6MjA3MTk5ODE5MX0.Ha4X3ahOyjHGifWOGjYOdRWcTKgThqwNYsltsP1fuaw";

const STORAGE_BUCKET = "animals"; // bucket do Storage para as fotos

let supabaseClient = null;

async function ensureSupabase() {
  if (supabaseClient) return supabaseClient;

  if (!(window.supabase && window.supabase.createClient)) {
    await new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabaseClient;
}

/***********************
 * UTIL
 ***********************/
async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function esc(v) {
  return v == null
    ? ""
    : String(v).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function getAuthUser() {
  try { return JSON.parse(localStorage.getItem("authUser") || "{}"); } catch { return {}; }
}
function getLoggedRole() {
  const role = localStorage.getItem("usuarioLogado");
  return role || "user";
}

/** Upload da imagem para o bucket e retorno da URL pública */
async function uploadAnimalImage(file) {
  await ensureSupabase();

  if (!file) throw new Error("Nenhuma imagem selecionada.");
  if (!file.type.startsWith("image/")) throw new Error("Arquivo não é uma imagem.");
  const MAX = 5 * 1024 * 1024; // 5MB
  if (file.size > MAX) throw new Error("Imagem acima de 5MB.");

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const rnd = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const fileName = `${rnd}_${Date.now()}.${ext}`;

  // Mantemos uma pasta "animals/" dentro do bucket (opcional)
  const filePath = `animals/${fileName}`;

  const { error: upErr } = await supabaseClient.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, file, { contentType: file.type, upsert: false });

  if (upErr) throw upErr;

  const { data } = supabaseClient.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

/** Extrai o caminho (chave) dentro do bucket a partir da URL pública */
function extractStoragePathFromPublicUrl(publicUrl) {
  if (!publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    // Ex.: /storage/v1/object/public/<bucket>/<key...>
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("public");
    if (idx === -1 || !parts[idx + 1]) return null;
    const bucket = parts[idx + 1];
    if (bucket !== STORAGE_BUCKET) return null; // garante que é nosso bucket
    const keyParts = parts.slice(idx + 2);
    return keyParts.join("/");
  } catch {
    return null;
  }
}

/** Remove a imagem do Storage (ignora erro silenciosamente) */
async function deleteImageFromStorage(publicUrl) {
  if (!publicUrl) return;
  await ensureSupabase();
  const pathInBucket = extractStoragePathFromPublicUrl(publicUrl);
  if (!pathInBucket) return;
  const { error } = await supabaseClient.storage.from(STORAGE_BUCKET).remove([pathInBucket]);
  if (error) console.warn("Não foi possível remover a imagem do storage:", error);
}

/** Exclui o animal + formulários relacionados + auditoria + imagem.
 *  Bloqueia se houver adoção APROVADA.
 */
async function deleteAnimalCascade(animalId) {
  await ensureSupabase();

  const { data: animal, error: aErr } = await supabaseClient
    .from("animals")
    .select("id, name, image_url")
    .eq("id", animalId)
    .single();
  if (aErr || !animal) throw new Error("Animal não encontrado.");

  // Checa adoções
  const { data: ads, error: adErr } = await supabaseClient
    .from("adoptions")
    .select("id, status")
    .eq("animal_id", animalId);
  if (adErr) throw adErr;

  if (ads?.some(r => r.status === "aprovado")) {
    throw new Error("Este animal possui adoção APROVADA. Cancele a adoção antes de excluir.");
  }

  // Apaga auditorias -> adoptions -> animal
  const adoptionIds = (ads || []).map(r => r.id);
  if (adoptionIds.length) {
    await supabaseClient.from("adoption_audit").delete().in("adoption_id", adoptionIds);
    await supabaseClient.from("adoptions").delete().eq("animal_id", animalId);
  }

  // Remove imagem (se houver)
  await deleteImageFromStorage(animal.image_url);

  const { error: delErr } = await supabaseClient
    .from("animals")
    .delete()
    .eq("id", animalId);
  if (delErr) throw delErr;

  return { name: animal.name || "" };
}

/***********************
 * LOGIN (via banco, fallback local)
 ***********************/
window.login = async function (event) {
  event.preventDefault();
  const usuario = document.getElementById("usuario").value.trim(); // email
  const senha = document.getElementById("senha").value;

  await ensureSupabase();

  try {
    const passHash = await sha256Hex(senha);
    const { data: rows, error } = await supabaseClient
      .from("users")
      .select("id,name,email,role")
      .eq("email", usuario)
      .eq("password_hash", passHash)
      .limit(1);

    if (!error && rows && rows.length === 1) {
      const user = rows[0];
      localStorage.setItem("authUser", JSON.stringify(user));
      localStorage.setItem("usuarioLogado", user.role || "user");
      window.location.href = "home.html";
      return;
    }
  } catch (e) {
    console.warn("Falha ao autenticar via banco:", e);
  }

  // Fallback TEMPORÁRIO
  if (usuario === "admin" && senha === "1234") {
    localStorage.setItem("authUser", JSON.stringify({ id: "local-admin", name: "Admin", email: "admin@local", role: "admin" }));
    localStorage.setItem("usuarioLogado", "admin");
    window.location.href = "home.html";
    return;
  }
  if (usuario === "usuario" && senha === "4321") {
    localStorage.setItem("authUser", JSON.stringify({ id: "local-user", name: "Usuário", email: "user@local", role: "user" }));
    localStorage.setItem("usuarioLogado", "user");
    window.location.href = "home.html";
    return;
  }

  alert("E-mail ou senha inválidos.");
};

/***********************
 * PERFIL
 ***********************/
function rolePt(role) {
  if (!role) return "Usuário";
  return role === "admin" ? "Administrador" : "Usuário";
}
function setOrHide(lineEl, spanEl, value) {
  if (!lineEl || !spanEl) return;
  if (value && String(value).trim()) {
    spanEl.textContent = value;
    lineEl.style.display = "";
  } else {
    lineEl.style.display = "none";
  }
}
async function renderPerfilPage() {
  const nomeEl      = document.getElementById("perfil-nome");
  const emailEl     = document.getElementById("perfil-email");
  const tipoEl      = document.getElementById("perfil-tipo");
  const telLineEl   = document.getElementById("linha-telefone");
  const telEl       = document.getElementById("perfil-telefone");
  const endLineEl   = document.getElementById("linha-endereco");
  const endEl       = document.getElementById("perfil-endereco");
  const fotoEl      = document.getElementById("perfil-foto");

  if (!nomeEl && !fotoEl) return;

  const auth = getAuthUser();
  if (!auth || !auth.id) {
    if (nomeEl)  nomeEl.textContent  = "—";
    if (emailEl) emailEl.textContent = "—";
    if (tipoEl)  tipoEl.textContent  = "Usuário";
    if (fotoEl)  fotoEl.src          = "imagens/usuario.jpg";
    return;
  }

  if (nomeEl)  nomeEl.textContent  = auth.name  || "—";
  if (emailEl) emailEl.textContent = auth.email || "—";
  if (tipoEl)  tipoEl.textContent  = rolePt(auth.role);
  if (fotoEl)  fotoEl.src          = auth.photo_url || "imagens/usuario.jpg";
  setOrHide(telLineEl, telEl, auth.phone);
  setOrHide(endLineEl, endEl, auth.address || auth.city);

  try {
    await ensureSupabase();
    const { data: userDb } = await supabaseClient
      .from("users")
      .select("*")
      .eq("id", auth.id)
      .single();

    if (userDb) {
      if (nomeEl)  nomeEl.textContent  = userDb.name  || auth.name  || "—";
      if (emailEl) emailEl.textContent = userDb.email || auth.email || "—";
      if (tipoEl)  tipoEl.textContent  = rolePt(userDb.role || auth.role);
      if (fotoEl)  fotoEl.src          = userDb.photo_url || auth.photo_url || "imagens/usuario.jpg";
      setOrHide(telLineEl, telEl, userDb.phone || auth.phone);
      setOrHide(endLineEl, endEl, userDb.address || userDb.city || auth.address || auth.city);
    }
  } catch (e) {
    console.warn("Não foi possível atualizar perfil do banco:", e);
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("authUser");
      localStorage.removeItem("usuarioLogado");
    });
  }
}

/********************************************
 * UI: esconder aba Admin / bloquear páginas
 ********************************************/
function hideAdminTabIfNeeded() {
  const role = getLoggedRole();
  const adminLink =
    document.getElementById("admin") ||
    document.getElementById("adminLink") ||
    document.querySelector('a[href$="admin.html"]');

  if (adminLink && role !== "admin") {
    (adminLink.closest("li") || adminLink).style.display = "none";
  }
}
function guardAdminPages() {
  const role = getLoggedRole();
  const path = location.pathname;
  const isAdminArea =
    path.endsWith("/admin.html") ||
    path.endsWith("/cadastro.html") ||
    path.endsWith("/editar.html") ||
    path.endsWith("/formularios.html") ||
    path.endsWith("/edit-animal.html") ||
    path.endsWith("/formularios-animal.html") ||
    path.endsWith("/historico.html");

  if (isAdminArea && role !== "admin") {
    location.replace("home.html");
  }
}

/***************************
 * ANIMAIS - Listagem (cards)
 ***************************/
async function renderAnimais() {
  await ensureSupabase();
  const container =
    document.querySelector(".cards-container") ||
    document.getElementById("animais");
  if (!container) return;

  const { data: animals, error } = await supabaseClient
    .from("animals")
    .select("*")
    .eq("available", true) // somente disponíveis
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Erro ao carregar animais:", error);
    container.innerHTML = '<div class="alert alert-danger">Erro ao carregar animais.</div>';
    return;
  }

  container.innerHTML = "";
  if (!animals || animals.length === 0) {
    container.innerHTML = '<div class="text-muted">Nenhum animal disponível no momento.</div>';
    return;
  }

  animals.forEach((a) => {
    const imgUrl = a.image_url || "imagens/dog1.png";
    const card = `
      <div class="animal-card card shadow-sm p-3" style="width: 18rem;">
        <img src="${imgUrl}" alt="${esc(a.name)}" class="card-img-top mx-auto d-block"
             style="height: 200px; width: 200px; object-fit: cover;">
        <div class="card-body text-center">
          <h4 class="card-title">${esc(a.name || "Sem nome")}</h4>
          <p class="card-text">
            ${a.breed ? `Raça: ${esc(a.breed)}<br>` : ""}
            ${(a.age ?? "") !== "" ? `Idade: ${esc(a.age)} ${a.age > 1 ? "anos" : "ano"}<br>` : ""}
            ${a.size ? `Tamanho: ${esc(a.size)}<br>` : ""}
            ${a.description ? `${esc(a.description)}` : ""}
          </p>
          <div class="d-grid gap-2">
            <a href="animal.html?id=${a.id}" class="btn btn-outline-secondary">DETALHES</a>
            <a href="adotar.html?id=${a.id}" class="btn btn-success">QUERO ADOTAR</a>
          </div>
        </div>
      </div>`;
    container.insertAdjacentHTML("beforeend", card);
  });
}

/***********************************************
 * CADASTRO DE ANIMAL (admin) – COM FOTO OBRIGATÓRIA
 ***********************************************/
async function hookCadastroForm() {
  const form = document.getElementById("formCadastro");
  if (!form) return;
  await ensureSupabase();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const fields = form.querySelectorAll("input, textarea");
    const nome = fields[0]?.value?.trim() || null;
    const idade = parseInt(fields[1]?.value, 10) || null;
    const raca = fields[2]?.value?.trim() || null;
    const tamanho = fields[3]?.value?.trim() || null;
    const personalidade = fields[4]?.value?.trim() || "";
    const saude = fields[5]?.value?.trim() || "";

    // procura o input de arquivo
    const fileInput =
      form.querySelector('#foto') ||
      form.querySelector('input[name="foto"]') ||
      form.querySelector('input[type="file"]');
    const file = fileInput?.files?.[0] || null;
    if (!file) {
      alert("Selecione uma imagem do animal.");
      return;
    }

    let imageUrl = null;
    try {
      imageUrl = await uploadAnimalImage(file);
    } catch (err) {
      console.error("Falha no upload da imagem:", err);
      alert(`Erro ao enviar a imagem: ${err.message || err}`);
      return;
    }

    const description = [
      personalidade && `Personalidade: ${personalidade}`,
      saude && `Saúde: ${saude}`,
    ].filter(Boolean).join(" | ");

    const novo = {
      name: nome,
      species: "dog",
      breed: raca,
      age: idade,
      size: tamanho,
      description,
      available: true,
      image_url: imageUrl,
    };

    const { data, error } = await supabaseClient
      .from("animals")
      .insert([novo])
      .select("id")
      .single();

    if (error) {
      console.error("Erro ao cadastrar:", error);
      alert("Erro ao cadastrar o animal.");
      return;
    }

    window.location.href = `animal.html?id=${data.id}`;
  });
}

/************************************
 * DETALHE DE ANIMAL
 ************************************/
async function renderAnimalDetalhe() {
  const container = document.getElementById("animal-detalhe");
  if (!container) return;

  await ensureSupabase();

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    container.innerHTML = '<div class="alert alert-warning">Animal não encontrado.</div>';
    return;
  }

  const { data: animal, error } = await supabaseClient
    .from("animals")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !animal) {
    console.error("Erro ao buscar animal:", error);
    container.innerHTML = '<div class="alert alert-danger">Erro ao carregar o animal.</div>';
    return;
  }

  const imgUrl = animal.image_url || "imagens/dog1.png";
  container.innerHTML = `
    <div class="card shadow-sm">
      <div class="row g-0">
        <div class="col-md-4 d-flex align-items-center justify-content-center p-3">
          <img src="${imgUrl}" class="img-fluid rounded" alt="${esc(animal.name)}"
               style="max-width: 280px; height: 280px; object-fit: cover;">
        </div>
        <div class="col-md-8">
          <div class="card-body">
            <h3 class="card-title">${esc(animal.name || "Sem nome")}</h3>
            <p class="card-text">
              ${animal.species ? `<b>Espécie:</b> ${esc(animal.species)}<br>` : ""}
              ${animal.breed ? `<b>Raça:</b> ${esc(animal.breed)}<br>` : ""}
              ${(animal.age ?? "") !== "" ? `<b>Idade:</b> ${esc(animal.age)} ${animal.age > 1 ? "anos" : "ano"}<br>` : ""}
              ${animal.size ? `<b>Tamanho:</b> ${esc(animal.size)}<br>` : ""}
              ${animal.description ? `<b>Sobre:</b> ${esc(animal.description)}<br>` : ""}
              <b>Disponível:</b> ${animal.available ? "Sim" : "Não"}
            </p>
            <a class="btn btn-success" href="adotar.html?id=${animal.id}">Quero Adotar</a>
            <a class="btn btn-outline-secondary ms-2" href="animais.html">Voltar</a>
          </div>
        </div>
      </div>
    </div>
  `;
}

/*****************************************
 * ADOÇÃO - resumo + envio do pedido
 *****************************************/
async function hookAdotarPage() {
  const formEl = document.getElementById("formAdocao");
  const resumoEl = document.getElementById("resumoAnimal");
  if (!(formEl instanceof HTMLFormElement)) return;

  await ensureSupabase();

  formEl.setAttribute("method", "post");
  formEl.setAttribute("action", "#");

  const params = new URLSearchParams(location.search);
  const animalId = params.get("id");

  if (!animalId) {
    if (resumoEl) resumoEl.innerHTML = '<div class="alert alert-warning">Animal não informado.</div>';
    formEl.style.display = "none";
    return;
  }

  const { data: animal, error } = await supabaseClient
    .from("animals")
    .select("id,name,species,breed,age,size,description,image_url")
    .eq("id", animalId)
    .single();

  if (error || !animal) {
    console.error("Erro ao buscar animal:", error);
    if (resumoEl) resumoEl.innerHTML = '<div class="alert alert-danger">Erro ao carregar animal.</div>';
    formEl.style.display = "none";
    return;
  }

  if (resumoEl) {
    const mini = animal.image_url ? `<img src="${animal.image_url}" alt="" style="height:40px;width:40px;object-fit:cover;border-radius:6px;margin-right:8px">` : "";
    resumoEl.innerHTML = `
      <div class="card shadow-sm mb-3">
        <div class="card-body d-flex align-items-center">
          ${mini}
          <div>
            <h5 class="card-title mb-1">${esc(animal.name)}</h5>
            <p class="mb-0">
              ${animal.breed ? `Raça: ${esc(animal.breed)} • ` : ""}
              ${animal.size ? `Tamanho: ${esc(animal.size)} • ` : ""}
              ${(animal.age ?? "") !== "" ? `Idade: ${esc(animal.age)} ${animal.age > 1 ? "anos" : "ano"}` : ""}
            </p>
            ${animal.description ? `<small class="text-muted">${esc(animal.description)}</small>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();

    const fd = new FormData(formEl);
    const payload = {
      animal_id: animalId,
      adopter_name: fd.get("nome")?.toString().trim(),
      adopter_email: fd.get("email")?.toString().trim(),
      adopter_phone: fd.get("telefone")?.toString().trim(),
      adopter_city: fd.get("cidade")?.toString().trim(),
      message: fd.get("mensagem")?.toString().trim(),
      status: "requisitado",
    };

    const { error: insErr } = await supabaseClient
      .from("adoptions")
      .insert([payload]);

    if (insErr) {
      console.error("ERRO INSERT ADOCAO:", insErr);
      alert(`Erro ao enviar seu pedido.\n${insErr.message || ""}`);
      return;
    }

    alert("Pedido de adoção enviado com sucesso! Entraremos em contato para confirmar a adoção");
    window.location.href = `animal.html?id=${animalId}`;
  });
}

/* Lista de Pedidos de Adoção (admin geral) */
async function renderFormularios() {
  const tbody = document.getElementById("formularios-tbody");
  if (!tbody) return;

  await ensureSupabase();

  const { data, error } = await supabaseClient
    .from("adoptions")
    .select(`
      id,
      created_at,
      status,
      adopter_name,
      adopter_email,
      adopter_phone,
      message,
      animal:animals(name)
    `)
    .order("created_at", { ascending: false });

  tbody.innerHTML = "";

  if (error) {
    console.error("Erro ao carregar formulários:", error);
    tbody.innerHTML = `<tr><td colspan="5" class="text-danger">Erro ao carregar formulários.</td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Nenhum formulário recebido.</td></tr>`;
    return;
  }

  for (const f of data) {
    const contato = [f.adopter_phone, f.adopter_email].filter(Boolean).join(" / ");
    const animalNome = f.animal?.name || "—";
    const motivo = f.message || "—";
    const badge = f.status === "requisitado" ? "text-bg-warning"
                : f.status === "aprovado" ? "text-bg-success"
                : "text-bg-secondary";

    const tr = `
      <tr>
        <td>${esc(f.adopter_name || "—")}</td>
        <td>${esc(contato || "—")}</td>
        <td>${esc(animalNome)}</td>
        <td>${esc(motivo)}</td>
        <td><span class="badge ${badge}">${esc(f.status)}</span></td>
      </tr>
    `;
    tbody.insertAdjacentHTML("beforeend", tr);
  }
}

/* CADASTRO DE USUÁRIO */
async function hookCadastroUsuarioPage() {
  const form = document.getElementById("formCadastroUsuario");
  if (!form) return;

  await ensureSupabase();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = fd.get("name")?.toString().trim();
    const email = fd.get("email")?.toString().trim().toLowerCase();
    const password = fd.get("password")?.toString() || "";
    const confirm = fd.get("confirm")?.toString() || "";

    if (!name || !email || !password) {
      alert("Preencha todos os campos.");
      return;
    }
    if (password !== confirm) {
      alert("As senhas não conferem.");
      return;
    }
    if (password.length < 6) {
      alert("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    const password_hash = await sha256Hex(password);

    const { data, error } = await supabaseClient
      .from("users")
      .insert([{ name, email, password_hash, role: "user" }])
      .select("id,name,email,role")
      .single();

    if (error) {
      if (error.code === "23505") {
        alert("Este e-mail já está em uso.");
      } else {
        console.error("Erro ao cadastrar usuário:", error);
        alert("Erro ao cadastrar. Tente novamente.");
      }
      return;
    }

    localStorage.setItem("authUser", JSON.stringify(data));
    localStorage.setItem("usuarioLogado", data.role || "user");

    alert("Conta criada com sucesso!");
    window.location.href = "home.html";
  });
}

/*********************************************
 * EDITAR (lista) - popula editar.html (admin)
 *********************************************/
async function renderEditarLista() {
  const ul = document.getElementById("lista-editar");
  if (!ul) return;
  await ensureSupabase();

  const { data: animals, error } = await supabaseClient
    .from("animals")
    .select("id,name,breed,age,size,available")
    .order("created_at", { ascending: false });

  ul.innerHTML = "";

  if (error) {
    console.error("Erro ao carregar lista de edição:", error);
    ul.innerHTML = `<li class="list-group-item text-danger">Erro ao carregar animais.</li>`;
    return;
  }

  if (!animals || animals.length === 0) {
    ul.innerHTML = `<li class="list-group-item text-muted">Nenhum animal cadastrado.</li>`;
    return;
  }

  animals.forEach((a) => {
    const info = [
      a.breed && `Raça: ${esc(a.breed)}`,
      (a.age ?? "") !== "" && `Idade: ${esc(a.age)}`,
      a.size && `Tamanho: ${esc(a.size)}`,
      `Disponível: ${a.available ? "Sim" : "Não"}`
    ].filter(Boolean).join(" • ");

    const li = `
      <li class="list-group-item d-flex justify-content-between align-items-center">
        <div>
          <div><b>${esc(a.name || "Sem nome")}</b></div>
          <small class="text-muted">${info}</small>
        </div>
        <div class="d-flex gap-2">
          <a class="btn btn-primary btn-sm" href="edit-animal.html?id=${a.id}">Editar</a>
          <button type="button"
                  class="btn btn-outline-danger btn-sm btn-delete-animal"
                  data-id="${a.id}" title="Excluir">
            Excluir
          </button>
          <a class="btn btn-success btn-sm" href="formularios-animal.html?id=${a.id}">Registrar Adoção</a>
        </div>
      </li>
    `;
    ul.insertAdjacentHTML("beforeend", li);
  });

  // Evita múltiplos binds
  if (!ul.dataset.boundDelete) {
    ul.dataset.boundDelete = "1";
    ul.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".btn-delete-animal");
      if (!btn) return;

      const id = btn.getAttribute("data-id");
      // busca nome só para confirmar
      const { data: one } = await supabaseClient
        .from("animals")
        .select("name")
        .eq("id", id)
        .single();

      if (!confirm(`Tem certeza que deseja EXCLUIR o animal "${one?.name || ""}"?
Essa ação não pode ser desfeita.`)) return;

      try {
        await deleteAnimalCascade(id);
        const li = btn.closest("li");
        if (li) li.remove();
        alert("Registro excluído com sucesso.");
      } catch (err) {
        alert(err?.message || "Falha ao excluir o registro.");
        console.error("Erro ao excluir animal:", err);
      }
    });
  }
}

/**********************************************
 * EDITAR (form) - carrega e salva alterações
 **********************************************/
async function hookEditarAnimalPage() {
  const form = document.getElementById("formEditarAnimal");
  if (!form) return;
  await ensureSupabase();

  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  if (!id) {
    alert("Animal não informado.");
    location.replace("editar.html");
    return;
  }

  const { data: animal, error } = await supabaseClient
    .from("animals")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !animal) {
    console.error("Erro ao carregar animal:", error);
    alert("Erro ao carregar animal.");
    location.replace("editar.html");
    return;
  }

  form.elements["name"].value = animal.name ?? "";
  form.elements["age"].value = animal.age ?? "";
  form.elements["species"].value = animal.species ?? "";
  form.elements["breed"].value = animal.breed ?? "";
  form.elements["size"].value = animal.size ?? "";
  form.elements["description"].value = animal.description ?? "";
  form.elements["available"].checked = !!animal.available;

  // mostrar preview se já tem imagem
  const currentPreview = document.getElementById("previewEditar");
  if (currentPreview && animal.image_url) {
    currentPreview.src = animal.image_url;
    currentPreview.style.display = "block";
  }

  // cria o botão "Excluir" se não existir
  let delBtn = document.getElementById("btnExcluirAnimal");
  if (!delBtn) {
    delBtn = document.createElement("button");
    delBtn.id = "btnExcluirAnimal";
    delBtn.type = "button";
    delBtn.className = "btn btn-outline-danger ms-2";
    delBtn.textContent = "Excluir";

    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn && submitBtn.parentElement) {
      submitBtn.parentElement.appendChild(delBtn);
    } else {
      form.appendChild(delBtn);
    }
  }

  delBtn.onclick = async () => {
    if (!confirm(`Tem certeza que deseja EXCLUIR o animal "${animal.name || ""}"?
Essa ação não pode ser desfeita.`)) return;

    try {
      await deleteAnimalCascade(id);
      alert("Registro excluído com sucesso.");
      location.href = "editar.html";
    } catch (err) {
      alert(err?.message || "Falha ao excluir o registro.");
      console.error("Erro ao excluir animal:", err);
    }
  };

  // salvar alterações
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      name: form.elements["name"].value.trim() || null,
      age: form.elements["age"].value ? parseInt(form.elements["age"].value, 10) : null,
      species: form.elements["species"].value.trim() || null,
      breed: form.elements["breed"].value.trim() || null,
      size: form.elements["size"].value.trim() || null,
      description: form.elements["description"].value.trim() || null,
      available: form.elements["available"].checked
    };

    // se o admin escolheu uma nova imagem, faz upload e troca o image_url
    const newFile =
      document.getElementById("fotoEditar")?.files?.[0] ||
      form.querySelector('input[name="fotoEditar"]')?.files?.[0] ||
      form.querySelector('input[type="file"]')?.files?.[0] ||
      null;

    if (newFile) {
      try {
        const newUrl = await uploadAnimalImage(newFile);
        payload.image_url = newUrl;
      } catch (err) {
        console.error("Falha ao enviar nova imagem:", err);
        alert(`Erro ao enviar a nova imagem: ${err.message || err}`);
        return;
      }
    }

    const { error: upErr } = await supabaseClient
      .from("animals")
      .update(payload)
      .eq("id", id);

    if (upErr) {
      console.error("Erro ao salvar alterações:", upErr);
      alert("Erro ao salvar. Tente novamente.");
      return;
    }

    alert("Alterações salvas com sucesso!");
    location.href = "editar.html";
  });
}

/***********************************************************
 * FORMULÁRIOS RELACIONADOS AO ANIMAL (página por animal)
 ***********************************************************/
async function renderFormulariosPorAnimal() {
  const tbody = document.getElementById("formularios-animal-tbody");
  const resumo = document.getElementById("resumo-animal-rel");
  if (!tbody && !resumo) return;
  await ensureSupabase();

  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  if (!id) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6">Animal não informado.</td></tr>`;
    return;
  }

  // Animal base
  const { data: base, error: errBase } = await supabaseClient
    .from("animals")
    .select("id,name,breed,size,age,available,image_url")
    .eq("id", id)
    .single();

  if (errBase || !base) {
    console.error("Erro ao carregar animal base:", errBase);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-danger">Erro ao carregar animal.</td></tr>`;
    return;
  }

  if (resumo) {
    const mini = base.image_url ? `<img src="${base.image_url}" alt="" style="height:40px;width:40px;object-fit:cover;border-radius:6px;margin-right:8px">` : "";
    resumo.innerHTML = `
      <div class="mb-3 d-flex align-items-center">
        ${mini}
        <div>
          <h4 class="mb-1">${esc(base.name || "Sem nome")}</h4>
          <small class="text-muted">
            ${base.breed ? `Raça: ${esc(base.breed)} • ` : ""} 
            ${base.size ? `Tamanho: ${esc(base.size)} • ` : ""} 
            ${(base.age ?? "") !== "" ? `Idade: ${esc(base.age)} • ` : ""} 
            Disponível: ${base.available ? "Sim" : "Não"}
          </small>
        </div>
      </div>
    `;
  }

  // IDs relacionados (mesmo nome/raça/tamanho/idade)
  const ids = new Set([base.id]);
  async function addIdsBy(field, value) {
    if (value == null || value === "") return;
    const { data } = await supabaseClient.from("animals").select("id").eq(field, value);
    (data || []).forEach((r) => ids.add(r.id));
  }
  await addIdsBy("name", base.name);
  await addIdsBy("breed", base.breed);
  await addIdsBy("size", base.size);
  await addIdsBy("age", base.age);

  const idList = Array.from(ids);

  // busca formulários
  const { data: forms, error: errForms } = await supabaseClient
    .from("adoptions")
    .select(`
      id,
      animal_id,
      created_at,
      status,
      adopter_name,
      adopter_email,
      adopter_phone,
      message,
      animal:animals(id,name,breed,size,age)
    `)
    .in("animal_id", idList)
    .order("created_at", { ascending: false });

  tbody.innerHTML = "";

  if (errForms) {
    console.error("Erro ao carregar formulários relacionados:", errForms);
    tbody.innerHTML = `<tr><td colspan="6" class="text-danger">Erro ao carregar formulários.</td></tr>`;
    return;
  }
  if (!forms || forms.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Nenhum formulário relacionado encontrado.</td></tr>`;
    return;
  }

  for (const f of forms) {
    const contato = [f.adopter_phone, f.adopter_email].filter(Boolean).join(" / ");
    const a = f.animal || {};
    const animalInfo = `
      ${esc(a.name || "—")}
      <small class="text-muted">
        ${
          [a.breed && `Raça: ${esc(a.breed)}`, a.size && `Tam: ${esc(a.size)}`, (a.age ?? "") !== "" && `Id: ${esc(a.age)}`]
            .filter(Boolean)
            .join(" • ")
        }
      </small>
    `;
    const badge = f.status === "requisitado" ? "text-bg-warning"
                : f.status === "aprovado" ? "text-bg-success"
                : "text-bg-secondary";

    const selectable = f.status === "requisitado" ? "" : "disabled";

    const tr = `
      <tr data-adoption-id="${f.id}">
        <td class="text-center">
          <input type="radio" name="selAdoption" value="${f.id}" ${selectable}>
        </td>
        <td>${esc(f.adopter_name || "—")}</td>
        <td>${esc(contato || "—")}</td>
        <td>${animalInfo}</td>
        <td>${esc(f.message || "—")}</td>
        <td><span class="badge ${badge}">${esc(f.status)}</span></td>
      </tr>
    `;
    tbody.insertAdjacentHTML("beforeend", tr);
  }

  // liga o botão de aprovação
  const btn = document.getElementById("btnAprovar");
  if (btn) btn.onclick = () => aprovarAdocaoSelecionada(base);
}

/******************************************************
 * Aprovar requisição selecionada + cancelar demais + auditoria
 ******************************************************/
async function aprovarAdocaoSelecionada(animalBase) {
  await ensureSupabase();
  const selected = document.querySelector('input[name="selAdoption"]:checked');
  if (!selected) {
    alert("Selecione um formulário (status 'requisitado') para aprovar.");
    return;
  }
  const adoptionId = selected.value; // UUID string
  const admin = getAuthUser();

  // Buscar o formulário selecionado (precisamos do animal_id)
  const { data: form, error } = await supabaseClient
    .from("adoptions")
    .select(`
      id, animal_id, status,
      adopter_name, adopter_email, adopter_phone, message,
      animal:animals(id,name)
    `)
    .eq("id", adoptionId)
    .single();

  if (error || !form) {
    console.error("Erro ao carregar o formulário:", error);
    alert("Erro ao carregar o formulário selecionado.");
    return;
  }
  if (form.status !== "requisitado") {
    alert("Apenas pedidos com status 'requisitado' podem ser aprovados.");
    return;
  }

  const confirmMsg =
    `Aprovar a requisição de:\n` +
    `• Nome: ${form.adopter_name || "—"}\n` +
    `• E-mail: ${form.adopter_email || "—"}\n` +
    `• Telefone: ${form.adopter_phone || "—"}\n\n` +
    `Para o animal: ${form.animal?.name || animalBase.name || "—"}\n\n` +
    `Isso vai aprovar este pedido, cancelar os demais deste animal e removê-lo da listagem pública.`;
  if (!confirm(confirmMsg)) return;

  // 1) Aprovar o selecionado
  const nowIso = new Date().toISOString();
  const { error: upSelErr } = await supabaseClient
    .from("adoptions")
    .update({
      status: "aprovado",
      approved_at: nowIso,
      approved_by_admin_id: admin.id || null,
      approved_by_admin_name: admin.name || null,
      approved_by_admin_email: admin.email || null
    })
    .eq("id", adoptionId);

  if (upSelErr) {
    console.error("Erro ao aprovar:", upSelErr);
    alert("Falha ao aprovar a requisição.");
    return;
  }

  // 2) Cancelar os demais do mesmo animal
  const { error: upOthersErr } = await supabaseClient
    .from("adoptions")
    .update({
      status: "cancelado",
      cancelled_at: nowIso
    })
    .eq("animal_id", form.animal_id)
    .neq("id", form.id)
    .neq("status", "aprovado");

  if (upOthersErr) {
    console.warn("Aviso: falhou ao cancelar demais pedidos:", upOthersErr);
  }

  // 3) Marcar o animal como indisponível
  if (form.animal_id) {
    await supabaseClient.from("animals").update({ available: false }).eq("id", form.animal_id);
  }

  // 4) Auditoria
  const { error: audErr } = await supabaseClient
    .from("adoption_audit")
    .insert([{
      adoption_id: form.id,
      action: "aprovar",
      old_status: "requisitado",
      new_status: "aprovado",
      admin_id: admin.id || null,
      admin_name: admin.name || null,
      admin_email: admin.email || null
    }]);

  if (audErr) {
    console.error("Erro ao registrar auditoria:", audErr);
    alert("Aprovado, mas houve erro ao registrar auditoria.");
  } else {
    alert("Requisição aprovada, demais pedidos cancelados e auditoria registrada!");
  }

  window.location.href = "historico.html";
}

/***************************************
 * HISTÓRICO DE ADOÇÕES (apenas aprovados)
 ***************************************/
async function renderHistoricoAdocoes() {
  const tbody = document.getElementById("historico-tbody");
  if (!tbody) return;
  await ensureSupabase();

  const { data, error } = await supabaseClient
    .from("adoptions")
    .select(`
      id, approved_at,
      adopter_name, adopter_email, adopter_phone,
      approved_by_admin_name, approved_by_admin_email,
      animal:animals(name, breed, size, age)
    `)
    .eq("status", "aprovado")
    .order("approved_at", { ascending: false });

  tbody.innerHTML = "";

  if (error) {
    console.error("Erro ao carregar histórico:", error);
    tbody.innerHTML = `<tr><td colspan="6" class="text-danger">Erro ao carregar histórico.</td></tr>`;
    return;
  }
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Nenhuma adoção aprovada ainda.</td></tr>`;
    return;
  }

  for (const r of data) {
    const animalInfo = [
      r.animal?.breed && `Raça: ${esc(r.animal.breed)}`,
      r.animal?.size && `Tamanho: ${esc(r.animal.size)}`,
      (r.animal?.age ?? "") !== "" && `Idade: ${esc(r.animal.age)}`
    ].filter(Boolean).join(" • ");

    const contato = [r.adopter_phone, r.adopter_email].filter(Boolean).join(" / ");

    const tr = `
      <tr>
        <td>${esc(r.animal?.name || "—")}</td>
        <td><small class="text-muted">${animalInfo || "—"}</small></td>
        <td>${esc(r.adopter_name || "—")}</td>
        <td>${esc(contato || "—")}</td>
        <td>${r.approved_at ? new Date(r.approved_at).toLocaleString() : "—"}</td>
        <td>
          ${esc(r.approved_by_admin_name || "—")}
          <div><small class="text-muted">${esc(r.approved_by_admin_email || "")}</small></div>
        </td>
      </tr>
    `;
    tbody.insertAdjacentHTML("beforeend", tr);
  }
}

/***********************
 * INICIALIZAÇÃO GLOBAL
 ***********************/
document.addEventListener("DOMContentLoaded", async () => {
  hideAdminTabIfNeeded();
  guardAdminPages();

  await renderAnimais();              // animais.html
  await hookCadastroForm();           // cadastro.html (com upload de imagem)
  await renderAnimalDetalhe();        // animal.html
  await hookAdotarPage();             // adotar.html
  await renderFormularios();          // formularios.html
  await hookCadastroUsuarioPage();    // cadastro-usuario.html
  await renderPerfilPage();           // perfil.html

  await renderEditarLista();          // editar.html
  await hookEditarAnimalPage();       // edit-animal.html

  await renderFormulariosPorAnimal(); // formularios-animal.html
  await renderHistoricoAdocoes();     // historico.html
});
