export default function MeetKnockToast({ knocks, onAdmit, onReject }) {
  if (!knocks || knocks.length === 0) return null;

  return (
    <div className="meet-knock-toast-container">
      {knocks.map((knock) => (
        <div key={knock.socketId} className="meet-knock-toast">
          <div className="knock-info">
            <span className="knock-name">{knock.name}</span>
            <span className="knock-desc">wants to join this call</span>
          </div>
          <div className="knock-actions">
            <button className="knock-btn deny" onClick={() => onReject(knock.socketId)}>Deny</button>
            <button className="knock-btn admit" onClick={() => onAdmit(knock.socketId)}>Admit</button>
          </div>
        </div>
      ))}
    </div>
  );
}
