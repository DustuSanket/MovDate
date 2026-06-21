import { useEffect, useRef, useState } from 'react';

export default function ChatPanel({ messages, onSend, you }) {
  const [draft, setDraft] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  function handleSubmit(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft('');
  }

  return (
    <div className="chat-panel">
      <ul className="chat-messages" ref={listRef}>
        {messages.length === 0 && <li className="chat-empty">No messages yet — say hi.</li>}
        {messages.map((message) => (
          <li
            key={message.id}
            className={`chat-message ${message.authorId === you?.id ? 'chat-message--you' : ''}`}
          >
            <span className="chat-author">{message.authorId === you?.id ? 'You' : message.name}</span>
            <p>{message.text}</p>
          </li>
        ))}
      </ul>
      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a message"
          maxLength={500}
          aria-label="Chat message"
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
