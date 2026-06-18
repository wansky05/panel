const {fork} = require('child_process');
const chalk = require('chalk')
const path = require("path");
const fs = require("fs");
const tmpPath = path.join(process.cwd(), "temp");
if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath);
process.env.TMPDIR = tmpPath;  // Set langsung di induk
async function start(){
const child = fork('./server.js')
//send pesan ke child
//child.send("Hello Child")

//terima pesan dari child
child.on("message",msg=>{
console.log('child to parent =>',msg)
})

child.on("close",(close)=>{
//console.log('terclose', close)
console.log(chalk.black(chalk.bgRed(`Menjalankan Ulang Skrip`)))
start()
})

child.on("exit",(exit)=>{
//console.log('terexit', exit)
})

}
start()