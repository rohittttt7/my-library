let items = [];
let selectedCategory = "All";
let activeTab = "file";
let editingItem = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function fileType(item) {
  if (item.type === "youtube") return "youtube";
  if (item.type === "text") return "text";
  if (item.mime?.startsWith("image/")) return "image";
  if (item.mime?.startsWith("audio/")) return "audio";
  if (item.mime?.startsWith("video/")) return "video";
  if (item.mime === "application/pdf") return "pdf";
  if (item.mime?.includes("word") || item.mime?.includes("excel") || item.mime?.includes("presentation")) return "document";
  return "file";
}

function iconFor(item) {
  return {
    image: "▧", pdf: "▤", text: "≡", youtube: "▶", document: "▦",
    audio: "♫", video: "▶", file: "◇"
  }[fileType(item)];
}

function categoryList() {
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].sort();
  return ["All", ...categories];
}

function updateCategories() {
  const counts = items.reduce((map, item) => {
    map[item.category] = (map[item.category] || 0) + 1;
    return map;
  }, {});

  $("categoryNav").innerHTML = categoryList().map((category) => `
    <button class="category-button ${category === selectedCategory ? "active" : ""}" data-category="${escapeHtml(category)}">
      <span>${escapeHtml(category)}</span>
      <span class="category-count">${category === "All" ? items.length : (counts[category] || 0)}</span>
    </button>
  `).join("");

  $("categoryNav").querySelectorAll(".category-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedCategory = button.dataset.category;
      closeSidebar();
      render();
    });
  });

  const categories = categoryList().filter((category) => category !== "All");
  const currentValue = editingItem?.category;
  $("categorySelect").innerHTML =
    categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("") +
    '<option value="__new">New category</option>';
  if (currentValue && categories.includes(currentValue)) $("categorySelect").value = currentValue;
}

function filteredItems() {
  const query = $("searchInput").value.trim().toLowerCase();
  let result = items.filter((item) => selectedCategory === "All" || item.category === selectedCategory);
  if (query) {
    result = result.filter((item) =>
      item.name.toLowerCase().includes(query) ||
      (item.category || "").toLowerCase().includes(query) ||
      (item.url || "").toLowerCase().includes(query) ||
      (item.text || "").toLowerCase().includes(query)
    );
  }

  const sort = $("sortSelect").value;
  return result.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "newest") return b.createdAt - a.createdAt;
    return a.number - b.number;
  });
}

function render() {
  updateCategories();
  const visible = filteredItems();
  $("sectionLabel").textContent = selectedCategory === "All" ? "All content" : selectedCategory;
  $("itemCount").textContent = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;

  if (!visible.length) {
    $("contentGrid").innerHTML = '<div class="empty"><strong>No content found</strong><br><br>Tap + to add something.</div>';
    return;
  }

  $("contentGrid").innerHTML = visible.map((item) => {
    const type = fileType(item);
    const preview = type === "youtube"
      ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(item.youtubeId)}/hqdefault.jpg" alt="">`
      : type === "image"
        ? `<img src="/uploads/${encodeURIComponent(item.filePath)}" alt="">`
        : `<span class="preview-icon">${iconFor(item)}</span>`;
    return `
      <article class="card">
        <button class="card-button" data-id="${escapeHtml(item.id)}">
          <div class="preview">${preview}</div>
          <div class="card-body">
            <div class="card-meta">
              <span class="number">#${String(item.number).padStart(3, "0")}</span>
              <span>${escapeHtml(item.extension || item.type)}</span>
            </div>
            <h3>${escapeHtml(item.name)}</h3>
            <span class="category-tag">${escapeHtml(item.category)}</span>
          </div>
        </button>
      </article>`;
  }).join("");

  $("contentGrid").querySelectorAll(".card-button").forEach((button) => {
    button.addEventListener("click", () => openViewer(button.dataset.id));
  });
}

function openDialog(item = null) {
  editingItem = item;
  $("addDialog").showModal();
  $("dialogTitle").textContent = item ? "Edit content" : "Add content";
  $("saveButton").textContent = item ? "Update" : "Save";
  $("fileInput").value = "";
  $("textTitle").value = item?.name || "";
  $("textBody").value = item?.text || "";
  $("youtubeTitle").value = item?.name || "";
  $("youtubeUrl").value = item?.url || "";
  $("itemName").value = item?.name || "";
  $("itemNumber").value = item?.number || "";
  $("categoryName").value = item?.category || "";
  $("editNameLabel").style.display = item ? "grid" : "none";
  $("numberLabel").style.display = item ? "grid" : "none";
  updateCategories();

  if (item) {
    activeTab = item.type === "youtube" ? "youtube" : item.type === "text" ? "text" : "file";
  } else {
    activeTab = "file";
  }
  setActiveTab(activeTab);

  $("filePanel").style.display = item && item.type === "file" ? "grid" : activeTab === "file" ? "grid" : "none";
  $("textTitle").closest("label").style.display = activeTab === "text" ? "grid" : "none";
  $("textBody").closest("label").style.display = activeTab === "text" ? "grid" : "none";
  $("youtubePanel").style.display = activeTab === "youtube" ? "grid" : "none";

  if (item && item.type !== "file") {
    $("categorySelect").value = item.category;
  }
  if (!item) {
    $("newCategory").value = "";
    $("categoryName").value = "";
    $("newCategoryLabel").style.display = "none";
    $("categoryNameLabel").style.display = "grid";
  }
}

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("filePanel").classList.toggle("active", tab === "file");
  $("textPanel").classList.toggle("active", tab === "text");
  $("youtubePanel").classList.toggle("active", tab === "youtube");
  $("filePanel").style.display = tab === "file" ? "grid" : "none";
  $("textPanel").style.display = tab === "text" ? "grid" : "none";
  $("youtubePanel").style.display = tab === "youtube" ? "grid" : "none";
  if (tab !== "file") $("fileInput").value = "";
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("visible");
  $("menuButton").setAttribute("aria-expanded", "false");
}

function openSidebar() {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("visible");
  $("menuButton").setAttribute("aria-expanded", "true");
}

async function openViewer(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  $("viewerTitle").textContent = `#${String(item.number).padStart(3, "0")} · ${item.name}`;
  const content = $("viewerContent");
  const type = fileType(item);

  if (type === "image") {
    content.innerHTML = `<img src="/uploads/${encodeURIComponent(item.filePath)}" alt="${escapeHtml(item.name)}">`;
  } else if (type === "pdf") {
    content.innerHTML = `<iframe src="/uploads/${encodeURIComponent(item.filePath)}" title="${escapeHtml(item.name)}"></iframe>`;
  } else if (type === "audio") {
    content.innerHTML = `<audio controls style="width:100%"><source src="/uploads/${encodeURIComponent(item.filePath)}"></audio>`;
  } else if (type === "video") {
    content.innerHTML = `<video controls src="/uploads/${encodeURIComponent(item.filePath)}"></video>`;
  } else if (type === "youtube") {
    content.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.youtubeId)}" title="${escapeHtml(item.name)}" allowfullscreen></iframe>
      <a class="download-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open on YouTube</a>`;
  } else if (type === "text") {
    content.innerHTML = `<div class="text-viewer">${escapeHtml(item.text || "")}</div>`;
  } else {
    content.innerHTML = `<p>Preview is not available for this file type.</p>`;
  }

  if (item.filePath) {
    content.insertAdjacentHTML("beforeend", `<a class="download-link" href="/uploads/${encodeURIComponent(item.filePath)}" download="${escapeHtml(item.originalFilename || item.name)}">Download</a>`);
  }
  content.insertAdjacentHTML("beforeend", `
    <div class="viewer-actions">
      <button type="button" class="secondary-button" id="moveUpButton">↑ Move up</button>
      <button type="button" class="secondary-button" id="moveDownButton">↓ Move down</button>
      <button type="button" class="secondary-button" id="editItemButton">Edit</button>
      <button type="button" class="danger-button" id="deleteItemButton">Delete</button>
    </div>`);

  async function moveItem(direction) {
    const sorted = [...items].sort((a, b) => a.number - b.number);
    const currentIndex = sorted.findIndex((entry) => entry.id === item.id);
    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= sorted.length) return;
    [sorted[currentIndex], sorted[targetIndex]] = [sorted[targetIndex], sorted[currentIndex]];
    await api("/api/items/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: sorted.map((entry) => entry.id) })
    });
    $("viewerDialog").close();
    await loadItems();
  }

  $("moveUpButton").addEventListener("click", () => moveItem(-1));
  $("moveDownButton").addEventListener("click", () => moveItem(1));

  $("editItemButton").addEventListener("click", () => {
    $("viewerDialog").close();
    openDialog(item);
  });
  $("deleteItemButton").addEventListener("click", async () => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    await api(`/api/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    $("viewerDialog").close();
    await loadItems();
  });

  $("viewerDialog").showModal();
}

async function loadItems() {
  items = await api("/api/items");
  render();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
});

$("categorySelect").addEventListener("change", () => {
  $("newCategoryLabel").style.display = $("categorySelect").value === "__new" ? "grid" : "none";
});

$("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = $("categorySelect").value;
  const typedCategory = $("categoryName").value.trim();
  const category = typedCategory
    || (selected === "__new" ? ($("newCategory").value.trim() || "General") : (selected || "General"));

  try {
    if (editingItem) {
      if (editingItem.type === "file") {
        await api(`/api/items/${encodeURIComponent(editingItem.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: $("itemName").value || editingItem.name, category, number: $("itemNumber").value })
        });
      } else if (editingItem.type === "text") {
        await api(`/api/items/${encodeURIComponent(editingItem.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: $("textTitle").value || editingItem.name, text: $("textBody").value, category, number: $("itemNumber").value })
        });
      } else {
        await api(`/api/items/${encodeURIComponent(editingItem.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: $("youtubeTitle").value, url: $("youtubeUrl").value, category, number: $("itemNumber").value })
        });
      }
    } else if (activeTab === "file") {
      const files = [...$("fileInput").files];
      if (!files.length) throw new Error("Please choose at least one file.");
      const form = new FormData();
      form.append("category", category);
      form.append("name", "");
      files.forEach((file) => form.append("files", file));
      await api("/api/items/file", { method: "POST", body: form });
    } else if (activeTab === "text") {
      await api("/api/items/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("textTitle").value, text: $("textBody").value, category })
      });
    } else {
      await api("/api/items/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("youtubeTitle").value, url: $("youtubeUrl").value, category })
      });
    }
    $("addDialog").close();
    editingItem = null;
    await loadItems();
  } catch (error) {
    alert(error.message);
  }
});

$("menuButton").addEventListener("click", openSidebar);
$("closeSidebar").addEventListener("click", closeSidebar);
$("overlay").addEventListener("click", closeSidebar);
$("fab").addEventListener("click", () => openDialog());
$("topAddButton").addEventListener("click", () => openDialog());
$("closeDialog").addEventListener("click", () => $("addDialog").close());
$("closeViewer").addEventListener("click", () => $("viewerDialog").close());
$("searchInput").addEventListener("input", render);
$("sortSelect").addEventListener("change", render);

loadItems().catch((error) => alert("Could not load the library: " + error.message));
