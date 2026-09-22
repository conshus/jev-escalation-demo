// Local state (In a real app, fetch these from your backend on page load)
let applicationId;
let sessionId;
let token;
let session;
let publisher;

// DOM Elements
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatWindow = document.getElementById('chat-window');
const videoModal = document.getElementById('video-modal');
const endCallBtn = document.getElementById('customer-end-call');
const subscriberEl = document.getElementById('subscriber-container');
const publisherEl = document.getElementById('publisher-container');

// Array to store chat history for Jev state
let messageHistory = [{ role: 'system', text: 'Hello! How can I help you today?' }];

async function initializeCustomer() {
  try {
    // Fetch a unique session for this user from your backend
    const res = await fetch('/api/auth/customer').then(r => r.json());
    applicationId = res.applicationId;
    sessionId = res.sessionId;
    token = res.token;

    // Initialize the session so we are ready if an escalation happens
    // session = OT.initSession(applicationId, sessionId);
  } catch (err) {
    console.error("Failed to initialize Vonage session credentials:", err);
  }
}

function appendMessage(role, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;
  msgDiv.innerText = text;
  chatWindow.appendChild(msgDiv);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (role !== 'system') {
    messageHistory.push({ role, text });
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  // 1. Show user message
  appendMessage('user', text);
  chatInput.value = '';

  try {
    // 2. Intercept: Send full history to Jev via Express
    const response = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messageHistory,
        customerId: 'user_' + Math.floor(Math.random() * 10000), // Dummy ID
        sessionId
      })
    });

    const data = await response.json();

    if (data.action === 'escalated') {
      appendMessage('system', data.message);
      chatInput.disabled = true;
      transitionToVideoCall();
      return;
    }

    // 3. Normal Flow: Hand off to WebLLM (Mocked here)
    appendMessage('system', 'Typing...');
    const aiResponse = await mockWebLLMResponse(text);
    appendMessage('bot', aiResponse);

  } catch (error) {
    console.error("Chat error:", error);
    appendMessage('system', "Sorry, I'm having trouble connecting.");
  }
});

function transitionToVideoCall() {
  // Disable chat UI
  // chatInput.disabled = true;
  // chatForm.querySelector('button').disabled = true;

  videoModal.showModal();
  session = OT.initSession(applicationId, sessionId);

  // Listen for the employee joining the session
  session.on('streamCreated', (event) => {
    // Open the modal once the employee arrives
    // videoModal.showModal();

    // session = OT.initSession(applicationId, sessionId);
    subscriberEl.innerHTML = ''; 

    document.getElementById('modal-title').textContent = "Live Support Connected";
    endCallBtn.style.display = 'block'; // Show hangup button once connected

    session.subscribe(event.stream, subscriberEl, {
      insertMode: 'append', width: '100%', height: '100%'
    });
  });

  // If the agent hangs up, this event fires
  session.on('connectionDestroyed', () => {
    endActiveCall('Agent ended the video call.');
  });

  // Connect to the Vonage Session and publish customer camera
  session.connect(token, (error) => {
    if (error) {
      console.error('Connection error:', error);
      return;
    }

    publisher = OT.initPublisher(publisherEl, {
      insertMode: 'append', width: '100%', height: '100%'
    });

    session.publish(publisher);
  });
}

// Dummy function to simulate WebLLM/Prompt API/AI Agent
async function mockWebLLMResponse(text) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(`This is a demo. "${text}" would be handled by the AI Agent and not get the call escalated to a live person. Try asking for an agent or human or sound frustrated.`);
    }, 1000);
  });
}

// Handle customer clicking the disconnect button
endCallBtn.addEventListener('click', () => {
  endActiveCall('You ended the video call.');
});

// Reusable cleanup function
function endActiveCall(systemMessage) {
  if (session) {
    session.disconnect();
    session = null;
  }
  videoModal.close();
  endCallBtn.style.display = 'none';
  chatInput.disabled = false;
  document.getElementById('modal-title').textContent = "Connecting to a Live Agent...";
  subscriberEl.innerHTML = '';
  appendMessage('system', systemMessage);
}

initializeCustomer();