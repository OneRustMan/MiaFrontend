import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import { ChatProvider } from "./hooks/useChat";
import DashboardView from "./pages/DashboardView";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ChatProvider>
              <App />
            </ChatProvider>
          }
        />
        <Route path="/dashboard" element={<DashboardView />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
