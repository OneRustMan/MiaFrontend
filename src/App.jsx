import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Leva } from "leva";
import { Experience } from "./components/Experience";
import { UI } from "./components/UI";
// ⚠️ TEMPORAL (pasos 3a/3b): disparador manual del chat en vivo. Sacar en 3c junto con el componente.
import { RealtimeChatDebugPanel } from "./components/RealtimeChatDebugPanel";

function App() {
  return (
    <>
      <Loader />
      <Leva hidden/>
      <UI />
      {/* ⚠️ TEMPORAL (pasos 3a/3b) — sacar en 3c */}
      <RealtimeChatDebugPanel />
      <Canvas shadows camera={{ position: [0, 0, 1], fov: 30 }}>
        <Experience />
      </Canvas>
    </>
  );
}

export default App;
