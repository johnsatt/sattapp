'use strict'
const LdapClient = require('ldapjs-client')
const zabbx = require('zabbix-promise/index')
const fs = require('fs')
const zbbServer = 'zabbix.incoma.lib' // dns/ip сервера Zabbix
const zbbHost = 'ipa.incoma.lib' //Имя хоста точно как в Zabbix сервере, на котором настроены принимающие трапперы
const timeToPassExpired = 172800000; //Пароль истекает через 2 дня в мс, либо уже истек
const searchinterval = 10000; // 10 мин (600000) интервал работы скрипта, как часто будет получать данные
const ipaURL = 'ldap://ipa.incoma.lib:389'
const bindUser = 'uid = searchuser, cn = users, cn = accounts, dc = incoma, dc = lib';
const bindPass = '12345678'
const searchScope = 'cn=users,cn=accounts,dc=incoma,dc=lib'
//----------------Trappers---------------------
const useradd = {   //Пользователь добавлен
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.add',
    value: ''
    }
const userdel = {   //Пользователь удален
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.del',
    value: ''
    }
const passwChng = { //Пароль изменен
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.pwd.chg',
    value: ''
    }
const paswExp = { //Пароль истекает
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.psw.exp',
    value: ''
}
const userenable = { //Пользователь разблокирован
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.enb',
    value: ''
}
const userdisable = { //Пользователь заблокирован
    server: zbbServer,
    host: zbbHost,
    key: 'trp.usr.dis',
    value: ''
}
//---------------EndTrappers-------------------

async function zabbsender(data, arg) {
    if (!!data) {arg.value = data;}
      await zabbx.sender(arg)
  }

function myLog(data) {
    if (!!data) {
        let logstring = `\n${Date()}     ${data}`;
        try {
            fs.appendFileSync('./messages.log', logstring);
        } catch (error) {
            // здесь ничего не поделать, если логгер не работает, жаловаться некому, разве что еще можно оставить console.log
        }
    }
}

// пробуем записать. Не смогли - логируем.
function writeFile(file, data) {
    if (!!file && !!data) {
        try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
        } catch (error) {
            myLog(error);
        }
    }
}

// пробуем читать. Не смогли - логируем.
function readFile (file) {
    let res = null;
    if (!!file) {
        try {
            res = JSON.parse(fs.readFileSync(file))
        } catch (error) {
            myLog(error);
        }
    }
    return res;
}

function myDateVerify(passdate) {
    return !!passdate && ((ParsDate(passdate).getTime() - Date.now()) < timeToPassExpired)


}
function ParsDate(input) {
    if(!!input) {
        return new Date(Date.UTC(
            parseInt(input.slice(0, 4), 10),
            parseInt(input.slice(4, 6), 10) - 1,
            parseInt(input.slice(6, 8), 10),
            parseInt(input.slice(8, 10), 10),
            parseInt(input.slice(10, 12), 10),
            parseInt(input.slice(12, 14), 10),
        ));
    }
};

function processLDAPAdd(LDAPData, DisUser) {
    if (!LDAPData) throw new Error('LDAPData is empty');
    //console.log(DisUser);
    DisUser = !DisUser ? { empty: {} } : DisUser;
    let disUserValues = Object.entries(DisUser).map(([key, value]) => value);

    // всему переданному LDAP проставим признак незалоченности
    for (let [key, value] of Object.entries(LDAPData)) {
        // если в массиве выключенных (disUserValues) нет имен вообще
        // или нет имен из переданного в LDAPData списке, то nsaccountlock будет false, иначе true, если совпадение нашлось
        LDAPData[key].nsaccountlock = disUserValues.findIndex(i=> !!i.dn && i.dn == value.dn) != -1;
    }
}
function dateConvert (date) {
    let timeStr = new Date(parseInt(date))
    return `0${timeStr.getDate()}`.substr(-2)+`.`+`0${timeStr.getMonth()}`.substr(-2)+`.${timeStr.getFullYear()} `+`0${timeStr.getHours()}`.substr(-2)+`:`+`0${timeStr.getMinutes()}`.substr(-2)
}
async function processForZabbix(LDAPData, FileData){
    if (!(!!LDAPData && !!FileData)) throw new Error('LDAPData or FileData are empty');
    let ldap = Object.entries(LDAPData).map(([key, value]) => value);
    let file = Object.entries(FileData).map(([key, value]) => value);

    if (ldap.length == 0) throw new Error('No Users in LDAP? Where is "Admin"?');

    let A = ldap.length <= file.length ? file : ldap;
    let B = A == file ? ldap : file;
    let zabMsg = A == file ? 'Users Deleted: ' : 'Users Added: ';
    let trap = A == file ? userdel : useradd;

    //User Add/Delete search
    let diffUsers = A.filter(i => B.findIndex(j => j.dn == i.dn) == -1);
    let diffNames = diffUsers.reduce((p,c) => `${p}${c.krbPrincipalName}\n`, '');
    if (diffUsers.length > 0) {
        await zabbsender(diffNames, trap);
        myLog(zabMsg + diffNames);
    }

    //User Enable/Disable search
    let enabledUsers = file.filter(i=>i.nsaccountlock && ldap.findIndex(j => !j.nsaccountlock && j.dn == i.dn) != -1);
    let disabledUsers = file.filter(i=>!i.nsaccountlock && ldap.findIndex(j => j.nsaccountlock && j.dn == i.dn) != -1);
    if (enabledUsers.length > 0) {
        let enabledUsersNames = enabledUsers.reduce((p,c) => `${p}${c.krbPrincipalName}\n`, '');
        myLog('Users Enabled: ' + enabledUsersNames);
        await zabbsender(enabledUsersNames, userenable);
    }
    if (disabledUsers.length > 0) {
        let disabledUsersNames = disabledUsers.reduce((p,c) => `${p}${c.krbPrincipalName}\n`, '');
        myLog('Users Disabled: ' + disabledUsersNames);
        await zabbsender(disabledUsersNames, userdisable);
    }

    // Search Password change
    let diffPass = B.filter(i => !!i.krbLastPwdChange && A.filter(j => !!j.krbLastPwdChange).findIndex(k => k.krbLastPwdChange == i.krbLastPwdChange) == -1);
    if (diffPass.length > 0){
        let diffPassRecords = diffPass.reduce((p,c) => `${p}${c.krbPrincipalName} Data: ${c.krbLastPwdChange}\n`, '');
        myLog(`Password change: ${diffPassRecords}`);
        await zabbsender(diffPassRecords, passwChng)
    }

    //Search password expired
    let diffExp = ldap.filter(i => !myDateVerify(i.krbPasswordExpiration) && !i.nsaccountlock);
    if (diffExp.length > 0) {
        let diffExpRecords = diffExp.reduce((p,c) => `${p}${dateConvert(ParsDate(c.krbPasswordExpiration).getTime())} ${c.krbPrincipalName}\n`, '');
        myLog(`Password expired: ${diffExpRecords}`);
        await zabbsender(diffExpRecords, paswExp)
    }
}


    // основные данные текущего и предыдущего шага. Здесь же и задаются начальные значения в момент запуска. Файл читается только один раз!
    let ldapPrev = readFile('./oldData.json');
    let ldapDis = null;
    let ldapCurrent = null;
    let ldap = null;

    async function myUnBind(){
        await ldap.unbind()
    }

    async function myLDAPBind() {
        await ldap.bind(bindUser, bindPass)
    }

    async function myLDAPsearch() {
        const options = {
            sizeLimit: 15000,
            filter: '(&(objectClass=posixAccount)(uid=*))',
            scope: 'sub',
            attributes: ['krbPrincipalName', 'krbLastPwdChange', 'krbPasswordExpiration', 'krbLastSuccessfulAuth']
        };
        return await ldap.search(searchScope, options);
    }

    async function myLDAPdisUserSearch() {
        const options = {
            filter: '(nsaccountlock=true)',
            scope: 'sub',
            attributes: ['krbPrincipalName']
            };
        return await ldap.search(searchScope, options);
    }
    // главный опрос, выполняемый в бесконечном цикле
    async function poll(){
        ldap = new LdapClient({ url: ipaURL })
        try {
            await myLDAPBind();
            ldapDis = await myLDAPdisUserSearch();
            ldapCurrent = await myLDAPsearch();
            processLDAPAdd(ldapCurrent, ldapDis); // обработается ldapCurrent на выходе

            // если что-то удалось прочитать либо из файла либо это не первая итерация тогда можем запустить обработчик заббикс
            if (!!ldapPrev && Object.keys(ldapPrev).length > 0) {
                await processForZabbix(ldapCurrent, ldapPrev);
            }
            await myUnBind();
            ldapPrev = ldapCurrent;
            writeFile('./oldData.json', ldapCurrent);
        }  catch (error) {
            myLog(error);
        }  finally {
            ldap = null;
        }
    }

    // бесконечный исполняемый цикл
    (function mainFunc() {
        poll();
        setTimeout(mainFunc, searchinterval);
    })();
