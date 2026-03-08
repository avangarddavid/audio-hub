const socket = io();

const generatedAtNode = document.querySelector("#generatedAt");
const connectedCountNode = document.querySelector("#connectedCount");
const outputSelect = document.querySelector("#outputSelect");
const refreshOutputsButton = document.querySelector("#refreshOutputs");
const sourceList = document.querySelector("#sourceList");
const sourceCardTemplate = document.querySelector("#sourceCardTemplate");

refreshOutputsButton.addEventListener("click", () => {
  socket.emit("outputs:refresh");
});

outputSelect.addEventListener("change", (event) => {
  socket.emit("output:select", {
    outputId: event.target.value
  });
});

socket.on("dashboard:error", ({ message }) => {
  window.alert(message);
});

socket.on("dashboard:state", (state) => {
  renderState(state);
});

function renderState(state) {
  generatedAtNode.textContent = new Date(state.generatedAt).toLocaleTimeString("ru-RU");
  connectedCountNode.textContent = state.sources.filter((source) => source.connected).length.toString();

  renderOutputs(state.output);
  renderSources(state.sources);
}

function renderOutputs(outputState) {
  const currentValue = outputSelect.value;
  outputSelect.innerHTML = "";

  for (const output of outputState.outputs) {
    const option = document.createElement("option");
    option.value = output.id;
    option.textContent = output.name;
    outputSelect.append(option);
  }

  outputSelect.value = outputState.selectedOutputId || currentValue;
}

function renderSources(sources) {
  sourceList.innerHTML = "";

  if (!sources.length) {
    const empty = document.createElement("p");
    empty.className = "source-meta";
    empty.textContent = "No sources connected yet.";
    sourceList.append(empty);
    return;
  }

  for (const source of sources) {
    const fragment = sourceCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".source-card");
    const nameNode = fragment.querySelector(".source-name");
    const platformNode = fragment.querySelector(".source-platform");
    const metaNode = fragment.querySelector(".source-meta");
    const statusNode = fragment.querySelector(".source-status");
    const slider = fragment.querySelector(".volume-slider");
    const volumeValueNode = fragment.querySelector(".volume-value");
    const muteButton = fragment.querySelector(".mute-button");

    nameNode.textContent = source.name;
    platformNode.textContent = source.platform;
    metaNode.textContent = [
      source.connected ? "online" : "offline",
      `${Math.round(source.volume * 100)}%`,
      `queue ${source.queueDepth}`,
      `latency ${source.latencyMs}ms`
    ].join(" | ");

    statusNode.textContent = !source.connected ? "offline" : source.active ? "playing" : "idle";
    statusNode.classList.toggle("is-active", source.active);
    statusNode.classList.toggle("is-offline", !source.connected);

    slider.value = Math.round(source.volume * 100);
    slider.disabled = !source.connected;
    volumeValueNode.textContent = `${slider.value}%`;
    slider.addEventListener("input", () => {
      volumeValueNode.textContent = `${slider.value}%`;
    });
    slider.addEventListener("change", () => {
      socket.emit("source:set-volume", {
        deviceId: source.deviceId,
        volume: Number(slider.value) / 100
      });
    });

    muteButton.textContent = source.muted ? "Unmute" : "Mute";
    muteButton.classList.toggle("is-muted", source.muted);
    muteButton.disabled = !source.connected;
    muteButton.addEventListener("click", () => {
      socket.emit("source:set-mute", {
        deviceId: source.deviceId,
        muted: !source.muted
      });
    });

    card.dataset.deviceId = source.deviceId;
    sourceList.append(fragment);
  }
}
