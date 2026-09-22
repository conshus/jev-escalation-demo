let applicationId;
let customerSession;

const dashboardAlerts = document.getElementById('dashboard-alerts');
const publisherEl = document.getElementById('publisher-container');
const subscriberEl = document.getElementById('subscriber-container');
const endCallBtn = document.getElementById('agent-end-call');

async function initializeDashboard() {
    const res = await fetch('/api/auth/dispatch').then(r => r.json());

    applicationId = res.applicationId;
    let dispatchSessionId = res.dispatchSessionId;
    let dispatchToken = res.dispatchToken;

    let dispatchSession = OT.initSession(applicationId, dispatchSessionId);

    dispatchSession.on('signal:escalation', (event) => {
        const payload = JSON.parse(event.data);
        showEscalationCard(payload);
    });

    dispatchSession.on('signal:claimed', (event) => {
        const payload = JSON.parse(event.data);
        removeEscalationCard(payload.customerId);
    });

    dispatchSession.connect(dispatchToken, (error) => {
        if (error) {
            console.error('Failed to connect to Dispatch Session:', error);
        } else {
            console.log('Employee connected to Dispatch. Waiting for escalations...');
        }
    });
}

function showEscalationCard(data) {
    if (document.getElementById(`escalation-${data.customerId}`)) return; // Prevent duplicates

    const card = document.createElement('article');
    card.id = `escalation-${data.customerId}`;
    card.className = 'escalation-card';
    card.innerHTML = `
    <h3>Escalation Alert</h3>
    <p><strong>Sentiment:</strong> ${data.sentiment}</p>
    <p><strong>Frustration Level:</strong> ${data.frustrationLevel}</p>
    <p><strong>Message:</strong> "${data.lastMessage}"</p>
    <button onclick="acceptEscalation('${data.customerId}', '${data.sessionId}')">
      Answer Call
    </button>
  `;
    dashboardAlerts.appendChild(card);
}

function removeEscalationCard(customerId) {
    const card = document.getElementById(`escalation-${customerId}`);
    if (card) card.remove();
}

// Ensure acceptEscalation is available globally for the inline onclick handler
window.acceptEscalation = async function (customerId, customerSessionId) {
    console.log('customerSessionId: ', customerSessionId);
    // 1. Tell backend to send 'signal:claimed'
    await fetch('/api/escalate/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId })
    });

    removeEscalationCard(customerId);

    // 2. Get a fresh publisher token for this specific customer session
    const { token } = await fetch('/api/auth/customer-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: customerSessionId })
    }).then(r => r.json());

    // 3. Connect to the Customer Session
    customerSession = OT.initSession(applicationId, customerSessionId);

    customerSession.on('streamCreated', (event) => {
        subscriberEl.innerHTML = ''; // Clear waiting text
        endCallBtn.style.display = 'block'; // Show hangup button when connected
        customerSession.subscribe(event.stream, subscriberEl, {
            insertMode: 'append', width: '100%', height: '100%'
        }, (error) => {
            if (error) console.error('Failed to subscribe:', error);
        });
    });

    // If the customer hangs up first, clean up the dashboard
    customerSession.on('connectionDestroyed', () => {
        resetVideoStage();
    });

    customerSession.connect(token, (error) => {
        if (error) {
            console.error('Failed to connect to Customer Session:', error);
            return;
        }

        publisherEl.innerHTML = ''; // Clear waiting text
        const publisher = OT.initPublisher(publisherEl, {
            insertMode: 'append', width: '100%', height: '100%'
        }, (pubError) => {
            if (pubError) console.error('Failed to init publisher:', pubError);
        });

        customerSession.publish(publisher, (pubError) => {
            if (pubError) console.error('Failed to publish stream:', pubError);
            else console.log('Successfully publishing to customer!');
        });
    });
};

// Handle agent clicking the disconnect button
endCallBtn.addEventListener('click', () => {
    resetVideoStage();
});

// Reusable cleanup function
function resetVideoStage() {
    if (customerSession) {
        customerSession.disconnect();
        customerSession = null;
    }
    endCallBtn.style.display = 'none';
    subscriberEl.innerHTML = 'Waiting for customer stream...';
    publisherEl.innerHTML = 'Your camera';
}

initializeDashboard();