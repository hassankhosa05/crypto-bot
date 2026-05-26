const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/backtest', (req, res) => {
    const { startDate, endDate, investment } = req.body;
    
    if (!startDate || !endDate || !investment) {
        return res.status(400).json({error: 'Missing fields'});
    }
    
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    
    if (end <= start) return res.status(400).json({error: 'End date must be after start date'});
    if (end - start > 30 * 24 * 60 * 60 * 1000) return res.status(400).json({error: 'Date range cannot exceed 30 days due to API limits.'});
    
    console.log(`Starting backtest child process: ${start} to ${end} with $${investment}`);
    const child = spawn('node', ['custom_backtester.js', start, end, investment]);
    let output = '';
    
    child.stdout.on('data', (data) => output += data.toString());
    child.stderr.on('data', (data) => console.error("Backtester Error:", data.toString()));
    
    child.on('close', (code) => {
        try {
            const jsonStartIndex = output.indexOf('{"success"');
            if (jsonStartIndex === -1) throw new Error("No JSON payload found");
            const result = JSON.parse(output.substring(jsonStartIndex));
            res.json(result);
        } catch(e) {
            console.error("Failed to parse backtester output:", e);
            res.status(500).json({error: 'Backtester failed', output});
        }
    });
});

app.listen(3000, () => console.log('Dashboard running on http://localhost:3000'));
