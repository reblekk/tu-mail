const {test}=require('node:test');
const assert=require('node:assert/strict');
const {accountProfile,allowedEmail,PROFILES}=require('../server/services/account-profiles');

test('allowedEmail accepts the configured domain and its subdomains only',()=>{
 assert.equal(allowedEmail('a@tu-darmstadt.de'),true);
 assert.equal(allowedEmail('a@stud.tu-darmstadt.de'),true);
 assert.equal(allowedEmail('A@Stud.TU-Darmstadt.DE'),true);
 assert.equal(allowedEmail('a@evil-tu-darmstadt.de'),false);
 assert.equal(allowedEmail('a@tu-darmstadt.de.evil.com'),false);
 assert.equal(allowedEmail('wrong'),false);
});

test('only the student mailbox type is offered, and it is the default',()=>{
 assert.deepEqual(Object.keys(PROFILES),['student']);
 const student=accountProfile({email:'a@stud.tu-darmstadt.de',username:'ab12cdef'});
 assert.equal(student.profile,'student');
 assert.equal(student.imapHost,'imap.stud.tu-darmstadt.de');
 assert.equal(student.imapUsername,'ab12cdef');
 assert.equal(student.smtpUsername,'ab12cdef');
 for(const profile of ['staff','linux','__proto__','constructor'])assert.throws(()=>accountProfile({email:'a@tu-darmstadt.de',username:'ab12cdef',profile}),{status:400});
});

test('accountProfile rejects unknown profiles so clients cannot choose hosts',()=>{
 assert.throws(()=>accountProfile({email:'a@tu-darmstadt.de',username:'ab12cdef',profile:'evil.example.com'}),{status:400});
});
