import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Vonage } from '@vonage/server-sdk';
import path from 'path';
import { fileURLToPath } from 'url';
// Import the official TypeSafe SDK primitives
import { TypeSafeClient, score, noul, choice } from '@typesafe-ai/sdk';

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Check for required env vars
if (!process.env.VONAGE_APPLICATION_ID || !process.env.VONAGE_PRIVATE_KEY) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}


// Initialize Vonage SDK
const vonage = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY
});

// In-memory store for room sessions
const roomToSessionIdDictionary = {};

// Helper to ensure the dispatch session always exists
async function getDispatchSessionId() {
  if (roomToSessionIdDictionary['dispatch']) {
    return roomToSessionIdDictionary['dispatch'];
  }

  // Create it on the fly if it doesn't exist yet
  const session = await vonage.video.createSession({ mediaMode: 'routed' });
  roomToSessionIdDictionary['dispatch'] = session.sessionId;
  console.log('Created new Dispatch Session:', session.sessionId);

  return session.sessionId;
}

// Initialize the TypeSafe Client (automatically reads TYPESAFE_API_KEY from .env)
const jev = new TypeSafeClient();

// Employee Dashboard Route & Auth
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/auth/dispatch', async (req, res) => {
  const dispatchSessionId = await getDispatchSessionId();
  const token = vonage.video.generateClientToken(dispatchSessionId, {
    role: 'subscriber' // Employees only listen in the dispatch session
  });

  res.json({
    applicationId: process.env.VONAGE_APPLICATION_ID,
    dispatchSessionId: dispatchSessionId,
    dispatchToken: token
  });
});

// Customer Auth (Generates a unique session per customer)
app.get('/api/auth/customer', async (req, res) => {
  try {
    const session = await vonage.video.createSession({ mediaMode: 'routed' });
    const token = vonage.video.generateClientToken(session.sessionId, {
      role: 'publisher'
    });

    res.json({
      applicationId: process.env.VONAGE_APPLICATION_ID,
      sessionId: session.sessionId,
      token: token
    });
  } catch (error) {
    console.error('Error creating customer session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Jev Interception & Escalation Trigger
app.post('/api/evaluate', async (req, res) => {
  // const { messages, customerId, sessionId } = req.body;
  const { messages } = req.body;

  try {
    // Call the System One endpoint
    const evaluation = await jev.systemOne({
      // We pass the full message array as the state
      state: messages,
      questions: {
        sentiment: choice("What is the user's current sentiment?", {
          happy: null,
          neutral: null,
          confused: null,
          frustrated: null,
          angry: null
        }),
        // Primitive 1: A Score out of 10 for frustration
        frustrationLevel: score("How frustrated is the user?", [
          "Calm, neutral, or happy",             // 0
          "Slightly annoyed but polite",         // 1
          "Visibly frustrated or impatient",     // 2
          "Extremely angry, aggressive, or rude" // 3
        ]),
        // Primitive 2: A Noul (Yes/No) for explicit human requests
        explicitEscalation: noul("Does the user explicitly ask to speak to a human, agent, or representative?")
      }
    });

    console.log('evaluation: ', evaluation);

    const userSentiment = evaluation.answers.sentiment.choice;
    const userSentimentConfidence = evaluation.answers.sentiment.confidence;
    const frustrationScore = evaluation.answers.frustrationLevel.score;
    const frustrationLevel = evaluation.answers.frustrationLevel.legend[Math.round(evaluation.answers.frustrationLevel.score)];
    const wantsHuman = evaluation.answers.explicitEscalation.noul > 0.8; // Returns true/false based on probability

    // 2. The Escalation Threshold
    if (frustrationScore >= 2 || (['frustrated', 'angry'].includes(userSentiment) && userSentimentConfidence > 0.8) || wantsHuman) {

      let message = `${wantsHuman || ['angry'].includes(userSentiment) ? "I'll connect you to a live agent." : 'It seems like you might need more help than I can offer. Would you like to connect with a live agent?'}`;
      return res.json({
        action: 'offer_escalation',
        sentiment: userSentiment,
        frustrationLevel: frustrationLevel,
        lastMessage: messages[messages.length - 1].text,
        message
      });
      // const dispatchSessionId = await getDispatchSessionId();

      // // Fire the signal into the Global Employee Dispatch Session
      // await vonage.video.sendSignal({
      //   type: 'escalation',
      //   data: JSON.stringify({
      //     customerId,
      //     sessionId,
      //     sentiment: userSentiment,
      //     frustrationLevel: frustrationLevel,
      //     lastMessage: messages[messages.length - 1].text
      //   })
      // }, dispatchSessionId);

      // // Tell the client to halt the local LLM generation
      // return res.json({
      //   action: 'escalated',
      //   message: 'Connecting you to a live agent...'
      // });
    }

    // 3. Normal Flow
    return res.json({ action: 'continue' });

  } catch (error) {
    console.error("Jev evaluation failed:", error);
    // Failsafe: if the evaluation fails, continue to the local LLM rather than breaking the chat.
    return res.json({ action: 'continue' });
  }
});

// Trigger the signal only when the user clicks the opt-in button
app.post('/api/escalate/trigger', async (req, res) => {
  const { customerId, sessionId, sentiment, frustrationLevel, lastMessage } = req.body;
  console.log('Trigger escalation request received: ', req.body);
  try {
    const dispatchSessionId = await getDispatchSessionId();
    console.log('Dispatch session ID obtained: ', dispatchSessionId);
    await vonage.video.sendSignal({
      type: 'escalation',
      data: JSON.stringify({ customerId, sessionId, sentiment, frustrationLevel, lastMessage })
    }, dispatchSessionId);
    console.log('Escalation signal sent successfully');
    res.json({ success: true });
  } catch (error) {
    console.log('Error sending escalation signal:', error);
    res.status(500).json({ error: 'Failed to broadcast escalation signal' });
  }
});

// Employee Claims the Call
app.post('/api/escalate/claim', async (req, res) => {
  const { customerId } = req.body;
  try {
    const dispatchSessionId = await getDispatchSessionId();
    // Tell other dashboard clients to remove the card
    await vonage.video.sendSignal({
      type: 'claimed',
      data: JSON.stringify({ customerId })
    }, dispatchSessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending claim signal:', error);
    res.status(500).json({ error: 'Failed to broadcast claim' });
  }
});

// Generate a token for the employee joining the customer's unique session
app.post('/api/auth/customer-token', (req, res) => {
  const { sessionId } = req.body;
  const token = vonage.video.generateClientToken(sessionId, {
    role: 'publisher'
  });
  res.json({ token });
});


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
