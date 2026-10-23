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

test('accountProfile builds usernames per mailbox type',()=>{
 const student=accountProfile({email:'a@stud.tu-darmstadt.de',username:'ab12cdef'});
 assert.equal(student.profile,'student');
 assert.equal(student.imapHost,PROFILES.student.host);
 assert.equal(student.imapUsername,'ab12cdef');
 assert.equal(accountProfile({email:'a@tu-darmstadt.de',username:'ab12cdef',profile:'staff'}).imapUsername,'ADS\\ab12cdef');
 assert.equal(accountProfile({email:'a@tu-darmstadt.de',username:'ab12cdef',profile:'linux'}).imapUsername,'ab12cdef@tu-darmstadt.de');
});

test('accountProfile rejects unknown profiles so clients cannot choose hosts',()=>{
 assert.throws(()=>accountProfile({email:'a@tu-darmstadt.de',username:'ab12cdef',profile:'evil.example.com'}),{status:400});
});
