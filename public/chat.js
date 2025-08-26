/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// === File upload DOM ===
const fileInput = document.getElementById("file-input");
const pinCheckbox = document.getElementById("pin-files");
const uploadStatus = document.getElementById("upload-status");

// helper to format GB
function fmtGB(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function checkQuota() {
  const r = await fetch("/api/quota");
  if (!r.ok) throw new Error("quota endpoint failed");
  return r.json();
}

async function uploadSelectedFiles() {
  const files = fileInput?.files;
  if (!files || files.length === 0) return;

  if (files.length > 20) {
    if (uploadStatus) uploadStatus.textContent = "⚠️ You can upload at most 20 files at once.";
    return;
  }

  // Check quota
  let quota;
  try {
    quota = await checkQuota();
  } catch (err) {
    if (uploadStatus) uploadStatus.textContent = "❌ Couldn’t check storage quota.";
    return;
  }

  if (!quota.okToUpload) {
    if (uploadStatus) {
      uploadStatus.textContent =
        (quota.message ||
          "Storage nearly full. Please delete some files before uploading.") +
        ` [${fmtGB(quota.usedBytes)} / ${fmtGB(quota.limitBytes)}]`;
    }
    return;
  }

  const form = new FormData();
  Array.from(files).forEach((f) => form.append("files", f));
  form.append("pin", String(pinCheckbox?.checked ?? false));

  if (uploadStatus) uploadStatus.textContent = "Uploading…";
  try {
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (uploadStatus) {
        uploadStatus.textContent =
          j.message || "❌ Upload failed. Check file types and try again.";
      }
      return;
    }
    if (uploadStatus) uploadStatus.textContent = `✅ Uploaded ${j.files.length} file(s).`;
    if (fileInput) fileInput.value = ""; // clear picker
  } catch {
    if (uploadStatus) uploadStatus.textContent = "❌ Network error while uploading.";
  }
}

// ---------------- Chat UI ----------------

const felicityOpeners = [
  "Well, finally. I was starting to wonder when you’d show up. Don’t worry, I’ve already anticipated half of what you’re about to ask. Go on — surprise me.",
  "I’ve been running your day in my head already. Care to tell me if I got it right, or should I just handle it for you?",
  "You know I’m three steps ahead, right? But fine — let’s pretend I don’t already know what you need. What’s first?",
  "Let’s cut to it. You’ve got a lot to do, and I’m the one who makes sure you don’t miss a beat. What’s top of the list?",
  "Of course I’m here. I’m always here. The real question is: are you ready to keep up?",
];

let chatHistory = [
  {
    role: "assistant",
    content: felicityOpeners[Math.floor(Math.random() * felicityOpeners.length)],
  },
];

function addMessageToUI(role, content) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}-message`;
  const p = document.createElement("p");
  p.textContent = content;
  wrap.appendChild(p);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

window.addEventListener("DOMContentLoaded", () => {
  for (const m of chatHistory) addMessageToUI(m.role, m.content);
});

let isProcessing = false;

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // Add message to history
  chatHistory.push({ role: "user", content: message });

  try {
    // Create new assistant response element
    const assistantMessageEl = document.createElement("div");
    assistantMessageEl.className = "message assistant-message";
    assistantMessageEl.innerHTML = "<p></p>";
    chatMessages.appendChild(assistantMessageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Send request to API
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: chatHistory,
      }),
    });

    // Handle errors
    if (!response.ok) {
      throw new Error("Failed to get response");
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk
      const chunk = decoder.decode(value, { stream: true });

      // Process SSE format
      const lines = chunk.split("\n");
      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line);
          if (jsonData.response) {
            // Append new content to existing text
            responseText += jsonData.response;
            assistantMessageEl.querySelector("p").textContent = responseText;

            // Scroll to bottom
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch (e) {
          console.error("Error parsing JSON:", e);
        }
      }
    }

    // Add completed response to chat history
    chatHistory.push({ role: "assistant", content: responseText });
  } catch (error) {
    console.error("Error:", error);
    addMessageToChat(
      "assistant",
      "Sorry, there was an error processing your request.",
    );
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${content}</p>`;
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// === File upload: auto-upload after selection (add this at the end) ===
if (fileInput) {
  fileInput.addEventListener("change", uploadSelectedFiles);
}
