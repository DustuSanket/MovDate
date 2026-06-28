import ParticipantTile from './ParticipantTile.jsx';

export default function CallGrid({ participants, you, hostId, localStream, remoteStreams, speakerId }) {
  return (
    <div className="call-grid">
      {participants.map((participant) => {
        const isYou = participant.id === you?.id;
        return (
          <ParticipantTile
            key={participant.id}
            name={participant.name}
            isYou={isYou}
            isHost={participant.id === hostId}
            muted={participant.muted}
            cameraOff={participant.cameraOff}
            stream={isYou ? localStream : (remoteStreams[participant.id] && remoteStreams[participant.id][0])}
            speakerId={speakerId}
          />
        );
      })}
    </div>
  );
}
