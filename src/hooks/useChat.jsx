import { createContext, useContext, useEffect, useState } from "react";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";

const ChatContext = createContext();

async function readChatStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!rawEvent.startsWith("data: ")) continue;

      let data;
      try {
        data = JSON.parse(rawEvent.slice(6));
      } catch (e) {
        console.error("Error parseando evento SSE:", e, rawEvent);
        continue;
      }

      if (data.type === "chunk") {
        onChunk({
          text: data.text,
          audio: data.audio,
          lipsync: data.lipsync,
          facialExpression: data.facialExpression,
          animation: data.animation,
        });
      } else if (data.type === "error") {
        console.error("Error del servidor durante el stream:", data.error);
        return;
      } else if (data.type === "aborted" || data.type === "done") {
        return;
      }
    }
  }
}

export const ChatProvider = ({ children }) => {
  const chat = async (message) => {
    setLoading(true);
    try {
      const response = await fetch(`${backendUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const contentType = response.headers.get("Content-Type") || "";

      if (contentType.includes("text/event-stream")) {
        await readChatStream(response, (chunk) => {
          setMessages((messages) => [...messages, chunk]);
        });
      } else {
        const json = await response.json().catch(() => ({}));
        if (json.aborted) return; // sesión reseteada mientras procesaba, no hay nada que reproducir
        setMessages((messages) => [...messages, ...(json.messages || [])]);
      }
    } catch (e) {
      console.error("Error en chat():", e);
    } finally {
      setLoading(false);
    }
  };
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState();
  const [loading, setLoading] = useState(false);
  const [cameraZoomed, setCameraZoomed] = useState(true);
  const onMessagePlayed = () => {
    setMessages((messages) => messages.slice(1));
  };

  /**
   * Empuja un mensaje ya armado al final de la MISMA cola que alimenta al chat
   * por HTTP. `messages` es la cola, `message` es su cabeza y el Avatar reproduce
   * la cabeza; agregar al final es todo lo que hace falta para que un mensaje
   * suene y anime igual que los del /chat de siempre.
   *
   * Existe para la sesión en vivo (/chat/live): sus chunks llegan por WebSocket
   * pero salen del mismo turnPipeline del backend, así que tienen exactamente el
   * shape que espera el Avatar ({ text, audio, lipsync, facialExpression,
   * animation }). Reconstruir una segunda reproducción para ese camino habría
   * significado dos colas y dos formas de animar al mismo avatar.
   */
  const enqueueMessage = (msg) => {
    if (!msg) return;
    setMessages((messages) => [...messages, msg]);
  };

  useEffect(() => {
    if (messages.length > 0) {
      setMessage(messages[0]);
    } else {
      setMessage(null);
    }
  }, [messages]);

  return (
    <ChatContext.Provider
      value={{
        chat,
        message,
        onMessagePlayed,
        enqueueMessage,
        loading,
        cameraZoomed,
        setCameraZoomed,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
};
