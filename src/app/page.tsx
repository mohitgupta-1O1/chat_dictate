import { ChatDemo } from "@/demo/ChatDemo";
import { DictationMiniPlayer } from "@/features/dictation";

export default function Page() {
  return (
    <main className="chat">
      <h1>Chat dictation demo</h1>
      <ChatDemo />
      <DictationMiniPlayer />
    </main>
  );
}
